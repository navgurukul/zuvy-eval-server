import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiAssessmentMappingHelpers } from './ai-assessment.mapping.helpers';
import { AiAssessmentMappingService } from './ai-assessment.mapping.service';
import { parseAssessmentId } from './ai-assessment.controller';

/**
 * POST /ai-assessment/map-questions returned a bare 500.
 *
 * Mapping is the only search in the service that filters the vector store,
 * and it filters on `topic`. Qdrant Cloud refuses a filter on a field with no
 * payload index, and that index was only ever created by a manual admin
 * endpoint - the indexer creates the collection but never its indexes. So a
 * collection that was ever recreated could not be filtered, mapping failed,
 * and generation kept working throughout, because its searches use no filter
 * and swallow vector errors by design.
 *
 * Whatever the outside failure is, it reached the client as "Internal server
 * error" with nothing to say which step broke. These tests pin the three
 * fixes: the index is made to exist, an outside failure names its step, and
 * an id the database cannot read is a 400.
 */

type VectorMock = {
  createPayloadIndex: jest.Mock;
  search: jest.Mock;
};

function buildHelpers(vector: Partial<VectorMock> = {}) {
  const vectorService: VectorMock = {
    createPayloadIndex: jest.fn(() => Promise.resolve()),
    search: jest.fn(() => Promise.resolve([])),
    ...vector,
  };
  const helpers = new AiAssessmentMappingHelpers(
    {} as never,
    {} as never,
    vectorService as never,
    {} as never,
  );
  (helpers as unknown as { logger: Record<string, jest.Mock> }).logger = {
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  return { helpers, vectorService };
}

describe('AiAssessmentMappingHelpers.ensureTopicFilterIndex', () => {
  it('creates a keyword index on topic in the questions collection', async () => {
    const { helpers, vectorService } = buildHelpers();

    await helpers.ensureTopicFilterIndex();

    expect(vectorService.createPayloadIndex).toHaveBeenCalledWith(
      'QUESTIONS',
      'topic',
      'keyword',
    );
  });

  it('asks only once per process once it has succeeded', async () => {
    const { helpers, vectorService } = buildHelpers();

    await helpers.ensureTopicFilterIndex();
    await helpers.ensureTopicFilterIndex();
    await helpers.ensureTopicFilterIndex();

    expect(vectorService.createPayloadIndex).toHaveBeenCalledTimes(1);
  });

  it('does not fail the request when the index cannot be confirmed', async () => {
    const { helpers } = buildHelpers({
      createPayloadIndex: jest.fn(() => Promise.reject(new Error('wug lorp'))),
    });

    await expect(helpers.ensureTopicFilterIndex()).resolves.toBeUndefined();
  });

  it('tries again next time after a failure, rather than giving up for good', async () => {
    const createPayloadIndex = jest
      .fn()
      .mockRejectedValueOnce(new Error('wug lorp'))
      .mockResolvedValue(undefined);
    const { helpers } = buildHelpers({ createPayloadIndex });

    await helpers.ensureTopicFilterIndex();
    await helpers.ensureTopicFilterIndex();

    expect(createPayloadIndex).toHaveBeenCalledTimes(2);
  });
});

describe('AiAssessmentMappingHelpers.searchTopicScoped', () => {
  it('makes sure the filter index exists before the first filtered search', async () => {
    const order: string[] = [];
    const { helpers } = buildHelpers({
      createPayloadIndex: jest.fn(() => {
        order.push('index');
        return Promise.resolve();
      }),
      search: jest.fn(() => {
        order.push('search');
        return Promise.resolve([]);
      }),
    });

    // No orgId, so topic variants come from the name alone and no query runs.
    await helpers.searchTopicScoped([0.1, 0.2], ['blint'], 3);

    expect(order[0]).toBe('index');
    expect(order).toContain('search');
  });

  it('still searches when the index could not be confirmed', async () => {
    const { helpers, vectorService } = buildHelpers({
      createPayloadIndex: jest.fn(() => Promise.reject(new Error('wug lorp'))),
    });

    await helpers.searchTopicScoped([0.1, 0.2], ['blint'], 3);

    expect(vectorService.search).toHaveBeenCalled();
    expect(vectorService.search.mock.calls[0][0]).toMatchObject({
      collectionName: 'QUESTIONS',
      filter: { topic: 'blint' },
    });
  });
});

describe('AiAssessmentMappingService.mapQuestionsForAssessment', () => {
  const ASSESSMENT = {
    id: 7,
    bootcampId: 3,
    title: 'wug',
    description: 'lorp',
    totalNumberOfQuestions: 5,
  };

  function buildService(overrides: Record<string, jest.Mock> = {}) {
    const helpers = {
      loadAssessment: jest.fn(() => Promise.resolve(ASSESSMENT)),
      resolveAssessmentTopicNames: jest.fn(() => Promise.resolve(['blint'])),
      buildScopedQueryVector: jest.fn(() => Promise.resolve([0.1, 0.2])),
      clearExistingSets: jest.fn(() => Promise.resolve()),
      checkIsBaseline: jest.fn(() => Promise.resolve(true)),
      calculateSetSizes: jest.fn(() => ({
        commonPerSet: 2,
        uniquePerSet: 3,
        neededTotal: 5,
      })),
      searchTopicScoped: jest.fn(() => Promise.resolve([11, 12])),
      createBaselineSet: jest.fn(() => Promise.resolve({ setsCreated: 1 })),
      createLeveledSets: jest.fn(),
      ...overrides,
    };

    // Mirrors drizzle: the callback's rejection is the transaction's rejection,
    // which is what rolls it back.
    const transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      }),
    );

    const service = new AiAssessmentMappingService(
      { transaction } as never,
      helpers as never,
    );
    (service as unknown as { logger: Record<string, jest.Mock> }).logger = {
      warn: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    return { service, helpers, transaction };
  }

  it('names the vector search step when the store fails, instead of a bare 500', async () => {
    const { service } = buildService({
      searchTopicScoped: jest.fn(() =>
        Promise.reject(
          new Error('Bad Request: Index required but not found for "topic"'),
        ),
      ),
    });

    const result = service.mapQuestionsForAssessment(7, { orgId: 1 });

    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({
      response: { stage: 'vector search', aiAssessmentId: 7 },
    });
  });

  it('rolls the remap back when the search fails, leaving existing sets alone', async () => {
    // The failure must escape the transaction callback; that is what makes
    // drizzle roll back the clearExistingSets that ran just before it.
    const { service, transaction, helpers } = buildService({
      searchTopicScoped: jest.fn(() => Promise.reject(new Error('wug'))),
    });

    await expect(
      service.mapQuestionsForAssessment(7, { orgId: 1 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(helpers.clearExistingSets).toHaveBeenCalled();
    await expect(transaction.mock.results[0].value).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(helpers.createBaselineSet).not.toHaveBeenCalled();
  });

  it('names the embedding step, and never opens a transaction', async () => {
    const { service, transaction } = buildService({
      buildScopedQueryVector: jest.fn(() =>
        Promise.reject(new Error('429 rate limited')),
      ),
    });

    await expect(
      service.mapQuestionsForAssessment(7, { orgId: 1 }),
    ).rejects.toMatchObject({ response: { stage: 'embedding' } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('keeps the provider message out of the response, where it could leak a key', async () => {
    const { service } = buildService({
      buildScopedQueryVector: jest.fn(() =>
        Promise.reject(new Error('401 Incorrect API key provided: sk-proj-wug')),
      ),
    });

    const error = await service
      .mapQuestionsForAssessment(7, { orgId: 1 })
      .catch((e: ServiceUnavailableException) => e);

    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toMatch(
      /sk-proj|Incorrect API key/,
    );
  });

  it('logs why a network call failed, not just that it did', async () => {
    // The error seen in production. Node's fetch reports every network failure
    // as "fetch failed" and puts the reason on `cause`, which the stack trace
    // leaves out - so the first version of this log said only "fetch failed".
    const fetchFailed = Object.assign(new TypeError('fetch failed'), {
      cause: {
        code: 'UND_ERR_CONNECT_TIMEOUT',
        message: 'Connect Timeout Error (attempted address: wug.lorp:6333)',
      },
    });
    const { service } = buildService({
      searchTopicScoped: jest.fn(() => Promise.reject(fetchFailed)),
    });
    const logger = (service as unknown as { logger: { error: jest.Mock } })
      .logger;

    await expect(
      service.mapQuestionsForAssessment(442, { orgId: 1 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const line = String(logger.error.mock.calls[0][0]);
    expect(line).toContain('assessment=442 stage=vector search');
    expect(line).toContain('fetch failed');
    expect(line).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(line).toContain('wug.lorp:6333');
  });

  it('logs an error with no cause exactly as before', async () => {
    const { service } = buildService({
      searchTopicScoped: jest.fn(() => Promise.reject(new Error('blint'))),
    });
    const logger = (service as unknown as { logger: { error: jest.Mock } })
      .logger;

    await service
      .mapQuestionsForAssessment(7, { orgId: 1 })
      .catch(() => undefined);

    expect(String(logger.error.mock.calls[0][0])).toMatch(/failed: blint$/);
  });

  it('lets a meaningful HTTP error through unchanged', async () => {
    // A 404 for "no questions match these topics" already says what is wrong;
    // relabelling it a 503 would hide that.
    const { service } = buildService({
      searchTopicScoped: jest.fn(() =>
        Promise.reject(new NotFoundException('no questions')),
      ),
    });

    await expect(
      service.mapQuestionsForAssessment(7, { orgId: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still maps normally when nothing fails', async () => {
    const { service, helpers } = buildService();

    await expect(
      service.mapQuestionsForAssessment(7, { orgId: 1 }),
    ).resolves.toEqual({ setsCreated: 1 });
    expect(helpers.createBaselineSet).toHaveBeenCalled();
  });
});

describe('parseAssessmentId', () => {
  it('accepts a positive integer, as a number or a numeric string', () => {
    // With no ValidationPipe, numeric strings have always worked, so a client
    // may be sending them. Rejecting them now would break that client.
    expect(parseAssessmentId(800)).toBe(800);
    expect(parseAssessmentId('800')).toBe(800);
    expect(parseAssessmentId(' 800 ')).toBe(800);
  });

  it('rejects what Postgres cannot read as an id with a 400, not a 500', () => {
    for (const bad of [
      0,
      -3,
      1.5,
      '1.5',
      'wug',
      '',
      '   ',
      null,
      undefined,
      true,
      {},
      [800],
      Number.NaN,
    ]) {
      expect(() => parseAssessmentId(bad)).toThrow(BadRequestException);
    }
  });
});
