import { QuestionsProcessor } from './questions.processor';
import { parseVerifierVerdict } from 'src/ai-assessment/system_prompts/system_prompts';
import { LlmService } from 'src/llm/llm.service';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { VectorService } from 'src/vector/vector.service';
import { QuestionsService } from './questions.service';

/**
 * Both checks under test are content blind. The verifier sends a question,
 * reads back an option number and compares it with the key; the bank check
 * embeds a question, pulls neighbours and compares tokens. Neither knows what
 * a topic is, so the fixtures here are placeholder strings rather than
 * questions - a test that passed because of what the words meant would be
 * testing the wrong thing.
 *
 * Verifier decision table:
 *   verifier agrees          -> keep
 *   verifier picks another   -> drop
 *   verifier says "none"     -> drop
 *   no readable verdict      -> keep (an outage must not empty a batch)
 */

type Mcq = {
  question: string;
  options: Record<string, string>;
  correctOption: number;
};

const ITEM: Mcq = {
  question: 'wug lorp blint praxil doved',
  options: { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth' },
  correctOption: 2,
};

const OTHER_ITEM: Mcq = {
  question: 'skarn velm tarn quillow frennet',
  options: { '1': 'alpha', '2': 'beta', '3': 'gamma', '4': 'delta' },
  correctOption: 3,
};

const reply = (
  correctOption: number | null,
  computedAnswer = 'whatever',
): string => JSON.stringify({ computedAnswer, correctOption });

/** The private methods under test, named so the casts below stay readable. */
type Internals = {
  verifyKeyedAnswers(
    candidates: Array<{ q: Mcq; index: number }>,
    jobId: string,
  ): Promise<Set<number>>;
  findBankDuplicates(
    candidates: Array<{ q: Mcq; index: number }>,
    orgId: number | undefined,
    jobId: string,
  ): Promise<Map<number, string>>;
  logger: Record<string, jest.Mock>;
};

type VectorHit = { id: number; payload: { questionId: number } };

type Deps = {
  completion?: (prompt: string) => Promise<{ text: string }>;
  /** Texts the store "finds" near each generated question. */
  neighbourTexts?: string[];
  embedMany?: (texts: string[]) => Promise<number[][]>;
  search?: () => Promise<VectorHit[]>;
};

function buildProcessor(deps: Deps = {}) {
  const generateCompletion = jest.fn(
    deps.completion ?? (() => Promise.resolve({ text: reply(1) })),
  );
  const embedMany = jest.fn(
    deps.embedMany ??
      ((texts: string[]) => Promise.resolve(texts.map(() => [0.1, 0.2]))),
  );
  const search = jest.fn(
    deps.search ??
      (() => Promise.resolve([{ id: 1, payload: { questionId: 1 } }])),
  );
  const getQuestionTextsByIds = jest.fn(() =>
    Promise.resolve(deps.neighbourTexts ?? []),
  );

  const processor = new QuestionsProcessor(
    { generateCompletion, generateCompletionPreferring: (_p, prompt) => generateCompletion(prompt) } as unknown as LlmService,
    { getQuestionTextsByIds } as unknown as QuestionsService,
    { embedMany } as unknown as EmbeddingsService,
    { search } as unknown as VectorService,
  );

  // Silence the warn lines the rejection paths emit.
  (processor as unknown as Internals).logger = {
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  return {
    processor: processor as unknown as Internals,
    generateCompletion,
    embedMany,
    search,
    getQuestionTextsByIds,
  };
}

const withCandidates = (items: Mcq[]) =>
  items.map((q, index) => ({ q, index }));

const verify = (processor: Internals, items: Mcq[]): Promise<Set<number>> =>
  processor.verifyKeyedAnswers(withCandidates(items), 'test-job');

const checkBank = (
  processor: Internals,
  items: Mcq[],
): Promise<Map<number, string>> =>
  processor.findBankDuplicates(withCandidates(items), 1, 'test-job');

describe('parseVerifierVerdict', () => {
  it('distinguishes "none of these" from an unreadable reply', () => {
    expect(parseVerifierVerdict(reply(null, '7'))).toEqual({
      computedAnswer: '7',
      correctOption: null,
    });
    expect(parseVerifierVerdict('the model rambled')).toBeNull();
    expect(parseVerifierVerdict('')).toBeNull();
    expect(parseVerifierVerdict(undefined)).toBeNull();
  });

  it('tolerates code fences and surrounding prose', () => {
    const fenced = ['```json', '{"correctOption":1}', '```'].join('\n');
    expect(parseVerifierVerdict(fenced)).toEqual({
      computedAnswer: null,
      correctOption: 1,
    });
  });

  it('rejects an out-of-range option rather than keying it', () => {
    expect(parseVerifierVerdict('{"correctOption":7}')).toBeNull();
    expect(parseVerifierVerdict('{"correctOption":0}')).toBeNull();
  });

  it('rejects a reply carrying no verdict at all', () => {
    expect(parseVerifierVerdict('{"computedAnswer":"42"}')).toBeNull();
  });
});

describe('QuestionsProcessor.verifyKeyedAnswers', () => {
  it('keeps a question the verifier agrees with', async () => {
    const { processor } = buildProcessor({
      completion: () => Promise.resolve({ text: reply(2) }),
    });
    await expect(verify(processor, [ITEM])).resolves.toEqual(new Set());
  });

  it('drops a question the verifier answers differently', async () => {
    const { processor } = buildProcessor({
      completion: () => Promise.resolve({ text: reply(1) }),
    });
    await expect(verify(processor, [ITEM])).resolves.toEqual(new Set([0]));
  });

  it('drops a question whose answer the verifier finds in no option', async () => {
    const { processor } = buildProcessor({
      completion: () => Promise.resolve({ text: reply(null) }),
    });
    await expect(verify(processor, [ITEM])).resolves.toEqual(new Set([0]));
  });

  it('keeps every question when the provider is down, rather than emptying the batch', async () => {
    const { processor } = buildProcessor({
      completion: () => Promise.reject(new Error('provider unavailable')),
    });
    await expect(verify(processor, [ITEM, OTHER_ITEM])).resolves.toEqual(
      new Set(),
    );
  });

  it('keeps a question when the reply cannot be parsed', async () => {
    const { processor } = buildProcessor({
      completion: () =>
        Promise.resolve({ text: 'I think it is the second one.' }),
    });
    await expect(verify(processor, [ITEM])).resolves.toEqual(new Set());
  });

  it('keeps a question when the provider returns nothing', async () => {
    const { processor } = buildProcessor({
      completion: () => Promise.resolve({ text: '' }),
    });
    await expect(verify(processor, [ITEM])).resolves.toEqual(new Set());
  });

  it('reports rejections against original batch positions', async () => {
    const { processor } = buildProcessor({
      completion: (prompt) =>
        Promise.resolve({
          text: prompt.includes(OTHER_ITEM.question) ? reply(1) : reply(2),
        }),
    });
    // Only index 1 disagrees: it is keyed 3 and the verifier answers 1.
    await expect(verify(processor, [ITEM, OTHER_ITEM, ITEM])).resolves.toEqual(
      new Set([1]),
    );
  });

  it('asks once per question and never shows the verifier the key', async () => {
    const { processor, generateCompletion } = buildProcessor({
      completion: () => Promise.resolve({ text: reply(2) }),
    });

    await verify(processor, [ITEM, OTHER_ITEM]);

    expect(generateCompletion).toHaveBeenCalledTimes(2);
    const prompts = generateCompletion.mock.calls.map(([prompt]) => prompt);
    prompts.forEach((prompt) => {
      expect(prompt).not.toMatch(/correct answer is/i);
      expect(prompt).not.toMatch(/"correctOption":\s*\d/);
    });
    expect(prompts[0]).toContain(ITEM.question);
  });

  it('does nothing on an empty batch', async () => {
    const { processor, generateCompletion } = buildProcessor();
    await expect(verify(processor, [])).resolves.toEqual(new Set());
    expect(generateCompletion).not.toHaveBeenCalled();
  });
});

describe('QuestionsProcessor.findBankDuplicates', () => {
  it('drops a question that already exists in the bank', async () => {
    const { processor } = buildProcessor({ neighbourTexts: [ITEM.question] });

    const found = await checkBank(processor, [ITEM]);

    expect(found.has(0)).toBe(true);
    expect(found.get(0)).toContain('already in the bank');
  });

  it('keeps a question whose neighbours are merely related', async () => {
    const { processor } = buildProcessor({
      neighbourTexts: [OTHER_ITEM.question],
    });
    await expect(checkBank(processor, [ITEM])).resolves.toEqual(new Map());
  });

  it('searches from each generated question, not once for the topic', async () => {
    // This is what makes the whole bank reachable: a per-topic query returns
    // the same neighbourhood no matter what was generated.
    const { processor, embedMany, search } = buildProcessor({
      neighbourTexts: [],
    });

    await checkBank(processor, [ITEM, OTHER_ITEM]);

    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany.mock.calls[0][0]).toEqual([
      ITEM.question,
      OTHER_ITEM.question,
    ]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('keeps everything when embedding fails', async () => {
    const { processor, search } = buildProcessor({
      embedMany: () => Promise.reject(new Error('embeddings down')),
    });

    await expect(checkBank(processor, [ITEM])).resolves.toEqual(new Map());
    expect(search).not.toHaveBeenCalled();
  });

  it('keeps everything when the vector store is unavailable', async () => {
    const { processor } = buildProcessor({
      search: () => Promise.reject(new Error('vector store down')),
    });
    await expect(checkBank(processor, [ITEM])).resolves.toEqual(new Map());
  });

  it('keeps a question when the store returns no neighbours', async () => {
    const { processor } = buildProcessor({ search: () => Promise.resolve([]) });
    await expect(checkBank(processor, [ITEM])).resolves.toEqual(new Map());
  });

  it('does nothing on an empty batch', async () => {
    const { processor, embedMany } = buildProcessor();
    await expect(checkBank(processor, [])).resolves.toEqual(new Map());
    expect(embedMany).not.toHaveBeenCalled();
  });
});
