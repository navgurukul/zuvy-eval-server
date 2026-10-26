import { GenerationRefusedError, parseLlmMcq } from './mcqParser';

/**
 * The prompt asks the model to answer "{ error: GENERATION_FAILED }" when it
 * cannot ensure correctness, so that reply is part of the contract rather than
 * a malformed response. It arrives most often on a top-up round for a topic
 * whose do-not-repeat list has grown long enough that there is nothing new to
 * ask.
 */

const MCQ = {
  question: 'wug lorp blint',
  options: { '1': 'a', '2': 'b', '3': 'c', '4': 'd' },
  correctOption: 1,
};

describe('parseLlmMcq', () => {
  it('reads a normal batch', () => {
    const parsed = parseLlmMcq(JSON.stringify({ evaluations: [MCQ] }));
    expect(parsed.evaluations).toHaveLength(1);
  });

  it('accepts a bare array as the evaluations list', () => {
    expect(parseLlmMcq(JSON.stringify([MCQ])).evaluations).toHaveLength(1);
  });

  it('tolerates code fences around the JSON', () => {
    const fenced = [
      '```json',
      JSON.stringify({ evaluations: [MCQ] }),
      '```',
    ].join('\n');
    expect(parseLlmMcq(fenced).evaluations).toHaveLength(1);
  });

  it('reports a refusal as a refusal, not as malformed output', () => {
    // Previously this fell through to the schema check, which reported a
    // missing "evaluations" array: a zod dump in the logs, and a dead job,
    // for the model doing exactly what it was asked to do.
    expect(() =>
      parseLlmMcq(
        JSON.stringify({
          error: 'GENERATION_FAILED',
          reason: 'topic exhausted',
        }),
      ),
    ).toThrow(GenerationRefusedError);
  });

  it('carries the reason the model gave', () => {
    try {
      parseLlmMcq(
        JSON.stringify({
          error: 'GENERATION_FAILED',
          reason: 'topic exhausted',
        }),
      );
      fail('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(GenerationRefusedError);
      expect((err as GenerationRefusedError).reason).toBe('topic exhausted');
    }
  });

  it('handles a refusal that gives no reason', () => {
    try {
      parseLlmMcq(JSON.stringify({ error: 'GENERATION_FAILED' }));
      fail('expected a refusal');
    } catch (err) {
      expect((err as GenerationRefusedError).reason).toBe('no reason given');
    }
  });

  it('still rejects genuinely malformed output', () => {
    expect(() => parseLlmMcq('{"evaluations": "not an array"}')).toThrow(
      /did not match MCQ schema/,
    );
    expect(() => parseLlmMcq('no json here at all')).toThrow(/No JSON/);
  });
});
