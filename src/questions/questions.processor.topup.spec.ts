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

function isVerifierPrompt(prompt: string): boolean {
  return prompt.startsWith('Solve this multiple-choice question.');
}

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
    // The verifier disagrees with the first two questions it ever sees.
    const rejected = new Set([
      `${word(1)} lorp blint praxil`,
      `${word(2)} lorp blint praxil`,
    ]);
    const { processor, createManyWithOutbox, generationPrompts } =
      buildProcessor((q) => rejected.has(q));

    await runJob(processor, 10);

    expect(createManyWithOutbox).toHaveBeenCalledTimes(1);
    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(10);

    // Round 1 asked for 10 and lost 2; round 2 must ask for exactly 2.
    expect(generationPrompts).toHaveLength(2);
    expect(requestedCount(generationPrompts[0])).toBe(10);
    expect(requestedCount(generationPrompts[1])).toBe(2);
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

  it('tops up a short batch instead of failing the job', async () => {
    const { processor, createManyWithOutbox, generationPrompts } =
      buildProcessor(() => false, -2);

    await runJob(processor, 10);

    expect(createManyWithOutbox.mock.calls[0][0]).toHaveLength(10);
    // Round 1 gave 8, so a second round was needed.
    expect(generationPrompts.length).toBeGreaterThan(1);
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
    const { processor, generationPrompts } = buildProcessor(
      (q) => q === `${word(1)} lorp blint praxil`,
    );

    await runJob(processor, 5);

    expect(generationPrompts).toHaveLength(2);
    // Question 2 was accepted in round 1, so round 2 must be told not to
    // restate it.
    expect(generationPrompts[1]).toContain(`${word(2)} lorp blint praxil`);
  });
});
