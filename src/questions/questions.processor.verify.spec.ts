import { QuestionsProcessor, reviewableTopic } from './questions.processor';
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
    topic?: { name: string; description?: string; subtopics?: string[] } | null,
  ): Promise<Set<number>>;
  findBankDuplicates(
    candidates: Array<{ q: Mcq; index: number }>,
    orgId: number | undefined,
    jobId: string,
  ): Promise<Map<number, string>>;
  logger: Record<string, jest.Mock>;
};

type VectorHit = { id: number; payload: { questionId: number } };

/**
 * Stand-in for a real embedding: one dimension per distinct word.
 *
 * It has to behave like one in the two ways the code depends on - identical
 * text gives identical vectors, and text sharing no words gives orthogonal
 * ones. A mock returning the same vector for everything makes every question a
 * paraphrase of every other and hides real behaviour behind passing tests.
 */
function fakeEmbedding(text: string): number[] {
  const vector = new Array(64).fill(0) as number[];
  String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .forEach((word) => {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
      }
      vector[hash % 64] += 1;
    });
  return vector;
}

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
      ((texts: string[]) => Promise.resolve(texts.map(fakeEmbedding))),
  );
  const search = jest.fn(
    deps.search ??
      (() => Promise.resolve([{ id: 1, payload: { questionId: 1 } }])),
  );
  const getQuestionTextsByIds = jest.fn(() =>
    Promise.resolve(deps.neighbourTexts ?? []),
  );

  const processor = new QuestionsProcessor(
    {
      generateCompletion,
      generateCompletionPreferring: (_p, prompt) => generateCompletion(prompt),
    } as unknown as LlmService,
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

const verify = (
  processor: Internals,
  items: Mcq[],
  topic?: { name: string; description?: string; subtopics?: string[] } | null,
): Promise<Set<number>> =>
  processor.verifyKeyedAnswers(withCandidates(items), 'test-job', topic);

const TOPIC = { name: 'Permutation and Combination' };

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
      onTopic: null,
      difficulty: null,
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
      onTopic: null,
      difficulty: null,
    });
  });

  it('reads the review fields when they are present', () => {
    const verdict = parseVerifierVerdict(
      '{"computedAnswer":"6","correctOption":2,"onTopic":false,"difficulty":"HARD"}',
    );
    expect(verdict).toEqual({
      computedAnswer: '6',
      correctOption: 2,
      onTopic: false,
      difficulty: 'hard',
    });
  });

  it('treats a missing or unusable review field as "not answered", not as a failure', () => {
    // The answer check is what matters; a reply that omits or garbles the
    // review fields must still produce a usable verdict rather than collapsing
    // to "unverified" and letting the question through unchecked.
    const verdict = parseVerifierVerdict(
      '{"computedAnswer":"6","correctOption":2,"onTopic":"yes","difficulty":"quite hard"}',
    );
    expect(verdict).toMatchObject({
      correctOption: 2,
      onTopic: null,
      difficulty: null,
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

describe('reviewableTopic', () => {
  it('accepts a topic with a real name', () => {
    expect(reviewableTopic('Permutation', '', undefined)).toEqual({
      name: 'Permutation',
      description: undefined,
      subtopics: undefined,
    });
  });

  it('refuses to judge relevance against a numeric topic name', () => {
    // Topic names in this database include bare numbers. "Is this question
    // about 115?" gets a confident no for every question, which would drop a
    // whole batch and fail the job.
    expect(reviewableTopic('115', '', undefined)).toBeNull();
    expect(reviewableTopic('', '', [])).toBeNull();
  });

  it('accepts a meaningless name when there is a description or subtopics to go on', () => {
    expect(
      reviewableTopic('115', 'Counting arrangements and selections', undefined),
    ).toMatchObject({ description: 'Counting arrangements and selections' });
    expect(reviewableTopic('115', '', ['circular permutations'])).toMatchObject(
      {
        subtopics: ['circular permutations'],
      },
    );
  });

  it('ignores blank subtopics rather than counting them as context', () => {
    expect(reviewableTopic('115', '', ['', '   '])).toBeNull();
  });
});

describe('QuestionsProcessor review of relevance and difficulty', () => {
  const withReview = (
    correctOption: number,
    extra: Record<string, unknown>,
  ): string => JSON.stringify({ computedAnswer: 'x', correctOption, ...extra });

  it('drops a question the reviewer says belongs to another subject', async () => {
    const { processor } = buildProcessor({
      completion: () =>
        Promise.resolve({ text: withReview(2, { onTopic: false }) }),
    });
    await expect(verify(processor, [ITEM], TOPIC)).resolves.toEqual(
      new Set([0]),
    );
  });

  it('keeps a question the reviewer says is on topic', async () => {
    const { processor } = buildProcessor({
      completion: () =>
        Promise.resolve({ text: withReview(2, { onTopic: true }) }),
    });
    await expect(verify(processor, [ITEM], TOPIC)).resolves.toEqual(new Set());
  });

  it('keeps a question when the reviewer does not judge relevance at all', async () => {
    // Only an explicit false drops. A model that omits the field must leave
    // the question exactly as the answer check left it.
    const { processor } = buildProcessor({
      completion: () => Promise.resolve({ text: withReview(2, {}) }),
    });
    await expect(verify(processor, [ITEM], TOPIC)).resolves.toEqual(new Set());
  });

  it('does not ask for a relevance judgement when no topic is supplied', async () => {
    const { processor, generateCompletion } = buildProcessor({
      completion: () => Promise.resolve({ text: withReview(2, {}) }),
    });

    await verify(processor, [ITEM]);

    const prompt: string = generateCompletion.mock.calls[0][0];
    expect(prompt).not.toContain('onTopic');
  });

  it('keeps a question whose difficulty the reviewer disputes', async () => {
    // Difficulty is observability, not a gate: two models disagree about
    // easy-versus-medium on plenty of sound questions.
    const { processor } = buildProcessor({
      completion: () =>
        Promise.resolve({
          text: withReview(2, { onTopic: true, difficulty: 'hard' }),
        }),
    });

    const items = [
      { ...ITEM, difficulty: 'easy' } as Mcq & { difficulty: string },
    ];
    await expect(verify(processor, items, TOPIC)).resolves.toEqual(new Set());
  });

  it('drops an off-topic question without also blaming the answer', async () => {
    // The answer agrees; only relevance fails. The reason logged has to be the
    // real one or the log stops being usable for triage.
    const { processor } = buildProcessor({
      completion: () =>
        Promise.resolve({ text: withReview(2, { onTopic: false }) }),
    });

    await verify(processor, [ITEM], TOPIC);

    const warnings: string[] = processor.logger.warn.mock.calls.map(
      ([message]: [unknown]) => String(message),
    );
    expect(warnings.some((w) => w.includes('reason=off-topic'))).toBe(true);
    expect(warnings.some((w) => w.includes('reason=answer-disagreement'))).toBe(
      false,
    );
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

    // Every question in the batch is embedded together, in one call.
    expect(embedMany.mock.calls[0][0]).toEqual([
      ITEM.question,
      OTHER_ITEM.question,
    ]);
    // ...and each is then searched for separately.
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('does not embed neighbours when the store returned none', async () => {
    const { processor, embedMany } = buildProcessor({ neighbourTexts: [] });

    await checkBank(processor, [ITEM]);

    // Only the batch itself; no wasted call on an empty neighbour list.
    expect(embedMany).toHaveBeenCalledTimes(1);
  });

  it('drops a bank question that means the same despite different wording', async () => {
    // Token overlap cannot see this pair, because the mock embedding makes the
    // two texts identical in meaning while sharing no words.
    const { processor } = buildProcessor({
      neighbourTexts: ['skarn velm tarn quillow frennet'],
      embedMany: (texts: string[]) =>
        Promise.resolve(texts.map(() => [1, 0, 0])),
    });

    const found = await checkBank(processor, [ITEM]);

    expect(found.has(0)).toBe(true);
    expect(found.get(0)).toContain('means the same');
  });

  it('drops a paraphrase of an earlier question in the same batch', async () => {
    const { processor } = buildProcessor({
      neighbourTexts: [],
      embedMany: (texts: string[]) =>
        Promise.resolve(texts.map(() => [1, 0, 0])),
    });

    const found = await checkBank(processor, [ITEM, OTHER_ITEM]);

    // The earlier one survives; only the later is dropped.
    expect(found.has(0)).toBe(false);
    expect(found.get(1)).toContain('means the same as an earlier question');
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
