import { QuestionsProcessor } from './questions.processor';
import { LlmService } from 'src/llm/llm.service';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { VectorService } from 'src/vector/vector.service';
import { QuestionsService } from './questions.service';

/**
 * A job must store exactly the count it was asked for.
 *
 * Quality filtering drops individual questions, so without a top-up loop a
 * request for 60 quietly becomes 57. These tests drive the loop by rejecting
 * questions at the verifier and asserting on what reaches the database.
 *
 * The generated content is nonsense words with a running counter, so every
 * question is unique unless a test deliberately makes it otherwise. What is
 * under test is the accounting, not the questions.
 */

type Row = { question: string; difficulty: string };

/** Reads back the count the prompt asked for, so the mock honours the contract. */
function requestedCount(prompt: string): number {
  const match = /Generate EXACTLY (\d+)/.exec(prompt);
  return match ? Number(match[1]) : 0;
}

/**
 * Matched on the shape the verifier asks for rather than on its opening line.
 *
 * Keying this to the first sentence made the mock silently misroute every
 * verifier call the moment that sentence was reworded: the prompts fell
 * through to the generator, which answered them with a fresh batch of
 * questions, and six tests failed for reasons that had nothing to do with
 * what they were testing. The requested JSON shape is what actually
 * distinguishes the two prompts.
 */
function isVerifierPrompt(prompt: string): boolean {
  return prompt.includes('"correctOption": <1, 2, 3, 4 or null>');
}

/**
 * The coverage plan runs before generation and uses the same completion call,
 * so the mock has to tell them apart or a plan lands in the generation counts
 * and every assertion about round counts is off by one.
 */
function isPlanningPrompt(prompt: string): boolean {
  return prompt.startsWith('You are planning an assessment on');
}

const PLAN_REPLY = JSON.stringify({
  plan: [
    { subtopic: 'first area', exercise: 'first kind' },
    { subtopic: 'second area', exercise: 'second kind' },
    { subtopic: 'third area', exercise: 'third kind' },
  ],
});

/** The question text a verifier prompt is asking about. */
function questionInPrompt(prompt: string): string {
  const match = /Question:\n(.+)\n/.exec(prompt);
  return match ? match[1] : '';
}

/**
 * A distinct nonsense word per index, carrying no digits.
 *
 * The tokenizer splits letters from digits, so "wug1" and "wug2" reduce to the
 * same word plus a number the skeleton then drops - which makes every fixture
 * the same exercise and the variety check empties the batch. Encoding the
 * counter as letters keeps each question genuinely distinct.
 */
function word(n: number): string {
  let rest = n + 1;
  let out = '';
  while (rest > 0) {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return `zz${out}`;
}

/**
 * Stand-in for a real embedding: one dimension per distinct word.
 *
 * It must give distinct text distinct directions. A mock returning one vector
 * for everything makes every question a paraphrase of every other, so the
 * semantic duplicate check drops the whole batch and these tests measure
 * nothing.
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

describe('QuestionsProcessor top-up loop', () => {
  let counter = 0;

  /**
   * @param rejectIf decides which questions the verifier disagrees with.
   * @param miscount applied to the FIRST generation round only, so a test can
   *   make the model miscount once and behave afterwards. Applying it to every
   *   round would make a top-up of two return zero, which is a different case.
   */
  function buildProcessor(
    rejectIf: (question: string) => boolean,
    miscount = 0,
  ) {
    counter = 0;
    const generationPrompts: string[] = [];

    const generate = (prompt: string) => {
      if (isPlanningPrompt(prompt)) {
        return Promise.resolve({ text: PLAN_REPLY });
      }
      const isFirstRound = generationPrompts.length === 0;
      generationPrompts.push(prompt);
      const n = Math.max(
        0,
        requestedCount(prompt) + (isFirstRound ? miscount : 0),
      );
      const evaluations = Array.from({ length: n }, () => {
        counter += 1;
        return {
          question: `${word(counter)} lorp blint praxil`,
          solution: 'working',
          options: {
            '1': `${counter}a`,
            '2': `${counter}b`,
            '3': `${counter}c`,
            '4': `${counter}d`,
          },
          correctOption: 1,
          difficulty: 'easy',
          language: 'en',
          level: 'C',
        };
      });
      return Promise.resolve({ text: JSON.stringify({ evaluations }) });
    };

    const generateCompletion = jest.fn((prompt: string) => generate(prompt));

    const generateCompletionPreferring = jest.fn(
      (_provider: string, prompt: string) => {
        if (!isVerifierPrompt(prompt)) return generate(prompt);
        const question = questionInPrompt(prompt);
        // Agreeing means naming the keyed option, which is always 1 here.
        const correctOption = rejectIf(question) ? 2 : 1;
        return Promise.resolve({
          text: JSON.stringify({ computedAnswer: 'x', correctOption }),
        });
      },
    );

    const createManyWithOutbox = jest.fn((rows: Row[]) =>
      Promise.resolve(rows.map((r, i) => ({ ...r, id: i + 1 }))),
    );

    const questionsService = {
      resolveCanonicalTopic: () =>
        Promise.resolve({ topicName: 'Permutation', topicDescription: 'desc' }),
      getRecentQuestionsByTopic: () => Promise.resolve([]),
      getQuestionTextsByIds: () => Promise.resolve([]),
      createManyWithOutbox,
    };

    const processor = new QuestionsProcessor(
      {
        generateCompletion,
        generateCompletionPreferring,
      } as unknown as LlmService,
      questionsService as unknown as QuestionsService,
      {
        embed: () => Promise.resolve(fakeEmbedding('query')),
        embedMany: (texts: string[]) =>
          Promise.resolve(texts.map(fakeEmbedding)),
      } as unknown as EmbeddingsService,
      { search: () => Promise.resolve([]) } as unknown as VectorService,
    );

    (processor as unknown as { logger: Record<string, jest.Mock> }).logger = {
      warn: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    return {
      processor,
      createManyWithOutbox,
      generationPrompts,
      generateCompletion,
    };
  }

  const runJobWithDifficulty = (
    processor: QuestionsProcessor,
    count: number,
    batchQuestionCounts: { easy: number; medium: number; hard: number },
  ) =>
    (
      processor as unknown as {
        handleGenerateTopicBatch(job: unknown): Promise<void>;
      }
    ).handleGenerateTopicBatch({
      id: 'job-1',
      attemptsMade: 0,
      data: {
        topic: 'Permutation',
        topicName: 'Permutation',
        topicDescription: 'desc',
        count,
        batchQuestionCounts,
        orgId: 1,
        levelId: null,
      },
    });

  const runJob = (processor: QuestionsProcessor, count: number) =>
    (
      processor as unknown as {
        handleGenerateTopicBatch(job: unknown): Promise<void>;
      }
    ).handleGenerateTopicBatch({
      id: 'job-1',
      attemptsMade: 0,
      data: {
        topic: 'Permutation',
        topicName: 'Permutation',
        topicDescription: 'desc',
        count,
        orgId: 1,
        levelId: null,
      },
    });

  it('stores exactly the requested count when nothing is dropped', async () => {
    const { processor, createManyWithOutbox, generationPrompts } =
      buildProcessor(() => false);

    await runJob(processor, 10);

    expect(createManyWithOutbox).toHaveBeenCalledTimes(1);
    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(10);
    // No shortfall, so no second generation call.
    expect(generationPrompts).toHaveLength(1);
  });

  it('regenerates the shortfall so the stored count still matches the request', async () => {
    // A loss bigger than the round's own margin, so a second round is
    // genuinely needed rather than absorbed.
    const rejected = new Set(
      [1, 2, 3, 4, 5].map((n) => `${word(n)} lorp blint praxil`),
    );
    const { processor, createManyWithOutbox, generationPrompts } =
      buildProcessor((q) => rejected.has(q));

    await runJob(processor, 10);

    expect(createManyWithOutbox).toHaveBeenCalledTimes(1);
    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(10);

    // Round 1 asked for 12 (ten wanted, two spare) and kept 7 of them, so
    // round 2 asks for the 3 still missing plus its own margin.
    expect(generationPrompts).toHaveLength(2);
    expect(requestedCount(generationPrompts[0])).toBe(12);
    expect(requestedCount(generationPrompts[1])).toBe(5);
  });

  it('retries when nothing at all survived', async () => {
    // Nothing ever passes, so no round makes progress and there is nothing
    // worth keeping. A fresh prompt on a retry is the only way forward.
    const { processor, createManyWithOutbox } = buildProcessor(() => true);

    await expect(runJob(processor, 10)).rejects.toThrow(/no usable questions/);
    expect(createManyWithOutbox).not.toHaveBeenCalled();
  });

  it('keeps what passed when it cannot reach the full count', async () => {
    // One question is rejected forever, so the job can never reach ten. It
    // used to throw and discard the nine that were verified and good, then
    // retry five times regenerating them: a request for 30 came back as 20
    // because one question was missing, not because ten were bad.
    let seen = 0;
    const { processor, createManyWithOutbox } = buildProcessor(() => {
      // Reject exactly one question per round, whichever comes last.
      seen += 1;
      return seen % 10 === 0;
    });

    await runJob(processor, 10);

    expect(createManyWithOutbox).toHaveBeenCalledTimes(1);
    const stored = createManyWithOutbox.mock.calls[0][0];
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThanOrEqual(10);
  });

  it('succeeds on a short batch so BullMQ does not retry it', async () => {
    // Succeeding rather than throwing is what removes the retry, and with it
    // the risk a partial write was guarding against: nothing regenerates, so
    // nothing can be stored twice.
    const rejectAll = new Set<string>();
    const { processor, createManyWithOutbox } = buildProcessor((q) => {
      // Let the first round through, reject every top-up after it.
      if (rejectAll.has('started')) return true;
      if (q.includes(word(10))) {
        rejectAll.add('started');
        return true;
      }
      return false;
    });

    // Resolves rather than rejects: the job is done, not failed.
    await expect(runJob(processor, 10)).resolves.toBeUndefined();
    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(9);
  });

  it('trims an over-long batch instead of failing the job', async () => {
    // A model asked for ten returning eleven used to throw, costing a BullMQ
    // attempt and an exponential backoff for one extra question. A real job
    // spent four attempts and about two minutes on exactly this.
    const { processor, createManyWithOutbox, generationPrompts } =
      buildProcessor(() => false, +1);

    await runJob(processor, 10);

    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(10);
    // One round only: the extra was dropped, not regenerated.
    expect(generationPrompts).toHaveLength(1);
  });

  it('absorbs an ordinary loss without paying for a second round', async () => {
    // Two questions short of the twelve asked for still leaves the ten
    // wanted. This is the case the margin exists for: before it, a loss this
    // size cost a whole extra round, and five rounds of that still finished
    // a fifty-question request two or three questions short.
    const { processor, createManyWithOutbox, generationPrompts } =
      buildProcessor(() => false, -2);

    await runJob(processor, 10);

    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(10);
    expect(generationPrompts).toHaveLength(1);
  });

  it('tops up a short batch instead of failing the job', async () => {
    // Short by more than the margin covers, so the top-up still has to work.
    const { processor, createManyWithOutbox, generationPrompts } =
      buildProcessor(() => false, -6);

    await runJob(processor, 10);

    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(10);
    expect(generationPrompts.length).toBeGreaterThan(1);
  });

  it('spreads the spare questions across the difficulty mix', async () => {
    // The margin has to be spread the way the batch is. Given entirely to one
    // difficulty it covers drops there and nowhere else, so a mix weighted
    // towards easy still finishes a hard question short the moment a hard one
    // is dropped - and the count is then missed for a reason the margin was
    // added to remove.
    const { processor, generationPrompts } = buildProcessor(() => false);

    await runJobWithDifficulty(processor, 10, { easy: 3, medium: 4, hard: 3 });

    const asked =
      /Generate exactly (\d+) easy, (\d+) medium, and (\d+) hard/.exec(
        generationPrompts[0],
      );
    expect(asked).not.toBeNull();
    const [easy, medium, hard] = asked!.slice(1).map(Number);

    // Twelve asked for: the ten wanted plus two spare.
    expect(easy + medium + hard).toBe(12);
    expect(requestedCount(generationPrompts[0])).toBe(12);

    // No difficulty loses ground to make room for the spares.
    expect(easy).toBeGreaterThanOrEqual(3);
    expect(medium).toBeGreaterThanOrEqual(4);
    expect(hard).toBeGreaterThanOrEqual(3);
  });
  it('drops the difficulty constraint on the last round rather than losing the batch', async () => {
    // A model that returns the wrong difficulty mix tends to keep doing it.
    // Holding out for an exact mix spent the last round and failed the whole
    // job, which is how a request for 30 questions came back with 20.
    const { processor, createManyWithOutbox, generationPrompts } =
      buildProcessor(() => false, -3);

    await runJobWithDifficulty(processor, 10, { easy: 3, medium: 4, hard: 3 });

    // The count is met, which is the promise.
    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(10);

    // The last round asked for questions without naming a difficulty split.
    const last = generationPrompts[generationPrompts.length - 1];
    expect(last).not.toContain('REQUIRED DIFFICULTY COUNTS');
  });

  it('relaxes the variety check on the last round so the count is still met', async () => {
    // Every question shares one skeleton once the numbers are stripped, so
    // the variety cap would hold the batch short forever. A narrow topic
    // genuinely has few exercises, and the count is the promise; variety is a
    // preference that gives way on the final round.
    counter = 0;
    const generationPrompts: string[] = [];
    const createManyWithOutbox = jest.fn((rows: Row[]) =>
      Promise.resolve(rows.map((r, i) => ({ ...r, id: i + 1 }))),
    );

    const generate = (prompt: string) => {
      generationPrompts.push(prompt);
      const evaluations = Array.from({ length: requestedCount(prompt) }, () => {
        counter += 1;
        // Same wording every time: one template, numbers apart.
        return {
          question: `what is the range of ${counter}, ${counter + 1}, ${counter + 2}`,
          solution: 'working',
          options: { '1': 'a', '2': 'b', '3': 'c', '4': 'd' },
          correctOption: 1,
          difficulty: 'easy',
          language: 'en',
          level: 'C',
        };
      });
      return Promise.resolve({ text: JSON.stringify({ evaluations }) });
    };

    const processor = new QuestionsProcessor(
      {
        generateCompletion: jest.fn(generate),
        generateCompletionPreferring: jest.fn((_p: string, prompt: string) =>
          isVerifierPrompt(prompt)
            ? Promise.resolve({
                text: JSON.stringify({ computedAnswer: 'x', correctOption: 1 }),
              })
            : generate(prompt),
        ),
      } as unknown as LlmService,
      {
        resolveCanonicalTopic: () =>
          Promise.resolve({
            topicName: 'Statistics',
            topicDescription: 'desc',
          }),
        getRecentQuestionsByTopic: () => Promise.resolve([]),
        getQuestionTextsByIds: () => Promise.resolve([]),
        createManyWithOutbox,
      } as unknown as QuestionsService,
      {
        embed: () => Promise.resolve(fakeEmbedding('query')),
        embedMany: (texts: string[]) =>
          Promise.resolve(texts.map(fakeEmbedding)),
      } as unknown as EmbeddingsService,
      { search: () => Promise.resolve([]) } as unknown as VectorService,
    );
    (processor as unknown as { logger: Record<string, jest.Mock> }).logger = {
      warn: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    await runJob(processor, 10);

    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(10);
  });

  it('carries accepted questions into the next round so a top-up cannot repeat them', async () => {
    // Round 1 asks for 7 (five wanted, two spare) and loses all but the last,
    // so a second round is needed and has something accepted to carry.
    const rejected = new Set(
      [1, 2, 3, 4, 5, 6].map((n) => `${word(n)} lorp blint praxil`),
    );
    const { processor, generationPrompts } = buildProcessor((q) =>
      rejected.has(q),
    );

    await runJob(processor, 5);

    expect(generationPrompts).toHaveLength(2);
    // Question 7 was accepted in round 1, so round 2 must be told not to
    // restate it.
    expect(generationPrompts[1]).toContain(`${word(7)} lorp blint praxil`);
  });
});

/**
 * Planning runs on the input that used to switch it off.
 *
 * Naming sub-concepts in the request made planExerciseTypes return an empty
 * list and generate with no plan at all, so the richest input produced the
 * least structure. A reviewer then found that filling the context fields in
 * by hand was the only thing that reduced duplication - which was true, and
 * true in spite of the planner rather than because of it.
 */
describe('QuestionsProcessor coverage planning', () => {
  function build(data: Record<string, unknown>, planReply = PLAN_REPLY) {
    const prompts: string[] = [];
    let counter = 0;

    const generate = (prompt: string) => {
      prompts.push(prompt);
      if (prompt.startsWith('You are planning an assessment on')) {
        return Promise.resolve({ text: planReply });
      }
      const n = requestedCount(prompt);
      const evaluations = Array.from({ length: n }, () => {
        counter += 1;
        return {
          question: `${word(counter)} lorp blint praxil`,
          solution: 'working',
          options: {
            '1': `${counter}a`,
            '2': `${counter}b`,
            '3': `${counter}c`,
            '4': `${counter}d`,
          },
          correctOption: 1,
          difficulty: 'easy',
          language: 'en',
          level: 'C',
        };
      });
      return Promise.resolve({ text: JSON.stringify({ evaluations }) });
    };

    const processor = new QuestionsProcessor(
      {
        generateCompletion: jest.fn(generate),
        generateCompletionPreferring: jest.fn((_p: string, prompt: string) =>
          isVerifierPrompt(prompt)
            ? Promise.resolve({
                text: JSON.stringify({ computedAnswer: 'x', correctOption: 1 }),
              })
            : generate(prompt),
        ),
      } as unknown as LlmService,
      {
        resolveCanonicalTopic: () =>
          Promise.resolve({ topicName: 'Permutation', topicDescription: '' }),
        getRecentQuestionsByTopic: () => Promise.resolve([]),
        getQuestionTextsByIds: () => Promise.resolve([]),
        createManyWithOutbox: jest.fn((rows: Row[]) =>
          Promise.resolve(rows.map((r, i) => ({ ...r, id: i + 1 }))),
        ),
      } as unknown as QuestionsService,
      {
        embed: () => Promise.resolve(fakeEmbedding('query')),
        embedMany: (texts: string[]) =>
          Promise.resolve(texts.map(fakeEmbedding)),
      } as unknown as EmbeddingsService,
      { search: () => Promise.resolve([]) } as unknown as VectorService,
    );
    (processor as unknown as { logger: Record<string, jest.Mock> }).logger = {
      warn: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    const run = () =>
      (
        processor as unknown as {
          handleGenerateTopicBatch(job: unknown): Promise<void>;
        }
      ).handleGenerateTopicBatch({
        id: 'job-1',
        attemptsMade: 0,
        data: { topic: 'Permutation', orgId: 1, levelId: null, ...data },
      });

    const planPrompt = () =>
      prompts.find((p) => p.startsWith('You are planning an assessment on'));
    const genPrompt = () =>
      prompts.find((p) => p.includes('COVERAGE PLAN FOR THIS BATCH'));

    return { run, planPrompt, genPrompt, prompts };
  }

  it('still plans when the request names sub-concepts, and uses them', async () => {
    const { run, planPrompt } = build({
      count: 4,
      subtopics: ['alpha area', 'beta area'],
    });

    await run();

    expect(planPrompt()).toBeDefined();
    expect(planPrompt()).toContain('alpha area, beta area');
  });

  it('plans for the whole request, not just this batch', async () => {
    // Batch three of five planning ten cells plans the same ten as batch one.
    const { run, planPrompt } = build({
      count: 10,
      batchIndex: 2,
      batchCount: 5,
      totalCount: 50,
    });

    await run();

    expect(planPrompt()).toMatch(/Plan 50 questions/);
  });

  it('hands the generation prompt one planned line per question', async () => {
    const { run, genPrompt } = build({ count: 3 });

    await run();

    const prompt = genPrompt();
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Sub-concept: first area | Exercise: first kind');
    expect(prompt).toContain(
      'Sub-concept: second area | Exercise: second kind',
    );
  });

  it('generates without a plan rather than failing when one cannot be read', async () => {
    // A plan improves generation and is not a precondition for it, so an
    // unreadable one must leave generation exactly as it was.
    const { run, genPrompt, prompts } = build({ count: 3 }, 'the model rambled');

    await expect(run()).resolves.toBeUndefined();

    // No plan reached the generation prompt, and questions were still written.
    expect(genPrompt()).toBeUndefined();
    expect(
      prompts.some((text) => text.includes('Generate EXACTLY')),
    ).toBe(true);
  });
});
