import {
  OpenSearchVectorStore,
  resolveIndexPrefix,
} from './opensearch.vector-store';

/**
 * Each environment gets its own index.
 *
 * Dev and stage share one OpenSearch collection, and a question is stored
 * under its own id. Stage's questions are numbered from 1 in stage_template,
 * exactly like dev's in main, so one shared index would let a stage question
 * overwrite the dev question with the same id, and send each environment's
 * searches the other's questions. OPENSEARCH_INDEX_PREFIX keeps them apart,
 * and an unset prefix must leave dev's index exactly where it was.
 *
 * Constructing the store makes no network call - credentials are fetched per
 * request - so these tests touch no OpenSearch.
 */

describe('resolveIndexPrefix', () => {
  it('is empty when nothing is set, so dev keeps its index', () => {
    expect(resolveIndexPrefix(undefined)).toBe('');
    expect(resolveIndexPrefix(null)).toBe('');
    expect(resolveIndexPrefix('')).toBe('');
    expect(resolveIndexPrefix('   ')).toBe('');
  });

  it('accepts a prefix and lowercases it, since index names must be lowercase', () => {
    expect(resolveIndexPrefix('stage_')).toBe('stage_');
    expect(resolveIndexPrefix('STAGE_')).toBe('stage_');
    expect(resolveIndexPrefix(' stage- ')).toBe('stage-');
  });

  it('refuses anything that cannot start an index name', () => {
    // Refused at startup: a typo that wrote into the wrong index silently
    // would be far worse than a stack that will not boot until it is fixed.
    for (const bad of ['_stage', '-stage', 'sta ge', 'stage/', 'stage*', 'st"age']) {
      expect(() => resolveIndexPrefix(bad)).toThrow(/OPENSEARCH_INDEX_PREFIX/);
    }
  });
});

describe('OpenSearchVectorStore index names', () => {
  const saved = {
    host: process.env.OPENSEARCH_HOST,
    prefix: process.env.OPENSEARCH_INDEX_PREFIX,
  };

  beforeEach(() => {
    // Only the config passed in may decide the result.
    delete process.env.OPENSEARCH_HOST;
    delete process.env.OPENSEARCH_INDEX_PREFIX;
  });

  afterAll(() => {
    if (saved.host === undefined) delete process.env.OPENSEARCH_HOST;
    else process.env.OPENSEARCH_HOST = saved.host;
    if (saved.prefix === undefined) delete process.env.OPENSEARCH_INDEX_PREFIX;
    else process.env.OPENSEARCH_INDEX_PREFIX = saved.prefix;
  });

  /** A store whose client records the index every call is sent to. */
  function build(settings: Record<string, string>) {
    const store = new OpenSearchVectorStore({
      get: (key: string) => settings[key],
    } as never);
    (store as unknown as { logger: Record<string, jest.Mock> }).logger = {
      log: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };

    const indexes: string[] = [];
    (store as unknown as { client: unknown }).client = {
      search: jest.fn(({ index }: { index: string }) => {
        indexes.push(index);
        return Promise.resolve({ body: { hits: { hits: [] } } });
      }),
      indices: {
        exists: jest.fn(({ index }: { index: string }) => {
          indexes.push(index);
          return Promise.resolve({ body: true, statusCode: 200 });
        }),
      },
    };
    return { store, indexes };
  }

  const HOST = { OPENSEARCH_HOST: 'wug.lorp.aoss.amazonaws.com' };

  it('keeps dev on "questions" when no prefix is set', async () => {
    const { store, indexes } = build(HOST);

    await store.search('QUESTIONS', [0.1, 0.2]);
    await store.ensureCollection('QUESTIONS', 2);

    expect(indexes).toEqual(['questions', 'questions']);
  });

  it('puts stage on its own index when a prefix is set', async () => {
    const { store, indexes } = build({
      ...HOST,
      OPENSEARCH_INDEX_PREFIX: 'stage_',
    });

    await store.search('QUESTIONS', [0.1, 0.2]);
    await store.ensureCollection('QUESTIONS', 2);

    expect(indexes).toEqual(['stage_questions', 'stage_questions']);
  });

  it('refuses to start with a prefix that is not a valid index name', () => {
    expect(() =>
      build({ ...HOST, OPENSEARCH_INDEX_PREFIX: '_stage' }),
    ).toThrow(/OPENSEARCH_INDEX_PREFIX/);
  });
});
