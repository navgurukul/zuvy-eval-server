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

describe('QuestionsProcessor top-up loop', () => {
  let counter = 0;

  /**
   * @param rejectIf decides which questions the verifier disagrees with.
   */
  function buildProcessor(rejectIf: (question: string) => boolean) {
    counter = 0;
    const generationPrompts: string[] = [];

    const generate = (prompt: string) => {
      generationPrompts.push(prompt);
      const n = requestedCount(prompt);
      const evaluations = Array.from({ length: n }, () => {
        counter += 1;
        return {
          question: `wug lorp question number ${counter}`,
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
      getRecentQuestionTextsByTopic: () => Promise.resolve([]),
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
        embed: () => Promise.resolve([0.1]),
        embedMany: (texts: string[]) => Promise.resolve(texts.map(() => [0.1])),
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
      'wug lorp question number 1',
      'wug lorp question number 2',
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

  it('never stores the questions it did reach when it cannot reach the count', async () => {
    // Nothing ever passes, so no round can make progress.
    const { processor, createManyWithOutbox } = buildProcessor(() => true);

    await expect(runJob(processor, 10)).rejects.toThrow(/produced only 0\/10/);

    // The point of accumulating before writing: a job that cannot deliver the
    // full count writes nothing at all, rather than leaving a partial batch
    // behind for the retry to duplicate.
    expect(createManyWithOutbox).not.toHaveBeenCalled();
  });

  it('carries accepted questions into the next round so a top-up cannot repeat them', async () => {
    const { processor, generationPrompts } = buildProcessor(
      (q) => q === 'wug lorp question number 1',
    );

    await runJob(processor, 5);

    expect(generationPrompts).toHaveLength(2);
    // Question 2 was accepted in round 1, so round 2 must be told not to
    // restate it.
    expect(generationPrompts[1]).toContain('wug lorp question number 2');
  });
});
