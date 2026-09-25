import {
  generateMcqPromptFromSpec,
  parseExerciseTypes,
  planExerciseTypesPrompt,
} from './system_prompts';

/**
 * A topic name is not a plan. Fifty questions on "logarithm" with no subtopics
 * and no description came back as nine direct evaluations, seven
 * solve-for-the-argument and six simplify-a-sum: every answer correct, six
 * skills tested fifty times.
 *
 * Rejecting repeats afterwards cannot fix that on a narrow topic, because
 * removal only empties the batch. The model has to be told where else to go
 * before it writes.
 */

describe('planExerciseTypesPrompt', () => {
  const base = { topic: 'Logarithm', count: 10 };

  it('asks for kinds of exercise, not areas of the subject', () => {
    const prompt = planExerciseTypesPrompt(base).replace(/\s+/g, ' ');
    expect(prompt).toMatch(/DISTINCT kinds of exercise/i);
    expect(prompt).toMatch(/thing the student has to DO/i);
  });

  it('names every disguise a repeat has actually used', () => {
    // Each of these defeated a check that had been added for the one before
    // it: wording, then numbers, then nouns, then notation.
    const prompt = planExerciseTypesPrompt(base).replace(/\s+/g, ' ');
    expect(prompt).toMatch(
      /Changing the numbers, the names, the objects, the symbols or the wording/i,
    );
  });

  it('carries no example from any particular subject', () => {
    // A worked example in one subject steers the plan toward that subject.
    // Asked about arrays or general knowledge, a model shown a logarithm
    // example reaches for calculation.
    const prompt = planExerciseTypesPrompt({ topic: 'Arrays', count: 8 });
    expect(prompt).not.toMatch(
      /logarithm|log\d|permutation|combination|mean|median|equation/i,
    );
  });

  it('offers kinds of exercise that hold outside mathematics', () => {
    const prompt = planExerciseTypesPrompt({
      topic: 'General knowledge',
      count: 8,
    }).replace(/\s+/g, ' ');

    expect(prompt).toMatch(/recalling or recognising/i);
    expect(prompt).toMatch(/finding the flaw in a stated conclusion/i);
    // And asks for them in the topic's own words, not echoed back.
    expect(prompt).toMatch(/in the language of THIS topic/i);
  });

  it('allows a short list when the topic is genuinely narrow', () => {
    // A model told to reach a number will split hairs to get there.
    expect(planExerciseTypesPrompt(base).replace(/\s+/g, ' ')).toMatch(
      /Give FEWER than 10 if the topic honestly has fewer/i,
    );
  });

  it('shows what already exists so the plan reaches elsewhere', () => {
    const prompt = planExerciseTypesPrompt({
      ...base,
      existingQuestions: ['Evaluate log2(8).', 'Evaluate log3(27).'],
    });
    expect(prompt).toContain('Evaluate log2(8).');
    expect(prompt).toMatch(/Reach for ones they do not/i);
  });

  it('caps how many existing questions it pastes in', () => {
    const many = Array.from({ length: 100 }, (_, i) => `question ${i}`);
    const prompt = planExerciseTypesPrompt({
      ...base,
      existingQuestions: many,
    });
    expect(prompt).toContain('question 39');
    expect(prompt).not.toContain('question 40');
  });
});

describe('parseExerciseTypes', () => {
  it('reads a plan', () => {
    expect(
      parseExerciseTypes(
        '{"exerciseTypes":["evaluate a logarithm","solve for the base"]}',
      ),
    ).toEqual(['evaluate a logarithm', 'solve for the base']);
  });

  it('tolerates code fences', () => {
    const fenced = ['```json', '{"exerciseTypes":["a"]}', '```'].join('\n');
    expect(parseExerciseTypes(fenced)).toEqual(['a']);
  });

  it('drops repeats, which defeat the purpose of the list', () => {
    expect(
      parseExerciseTypes(
        '{"exerciseTypes":["Evaluate","evaluate","  Evaluate  ","solve"]}',
      ),
    ).toEqual(['Evaluate', 'solve']);
  });

  it('returns nothing rather than throwing on an unreadable reply', () => {
    // A plan is an improvement on generating blind, not a precondition.
    expect(parseExerciseTypes('not json')).toEqual([]);
    expect(parseExerciseTypes('{"somethingElse":[1]}')).toEqual([]);
    expect(parseExerciseTypes(undefined)).toEqual([]);
    expect(parseExerciseTypes('{"exerciseTypes":"not an array"}')).toEqual([]);
  });
});

describe('generateMcqPromptFromSpec with a plan', () => {
  it('lists the planned kinds and asks for one question each', () => {
    const prompt = generateMcqPromptFromSpec({
      topic: 'Logarithm',
      count: 3,
      exerciseTypes: ['evaluate a logarithm', 'solve for the base'],
    });

    expect(prompt).toContain('KINDS OF EXERCISE TO COVER');
    expect(prompt).toContain('1. evaluate a logarithm');
    expect(prompt).toContain('2. solve for the base');
    expect(prompt.replace(/\s+/g, ' ')).toMatch(
      /one question on each before returning to any of them/i,
    );
  });

  it('says what to do when the plan is shorter than the count', () => {
    const prompt = generateMcqPromptFromSpec({
      topic: 'Logarithm',
      count: 10,
      exerciseTypes: ['evaluate a logarithm'],
    }).replace(/\s+/g, ' ');

    expect(prompt).toMatch(/rather than inventing near-copies/i);
  });

  it('leaves the prompt untouched when there is no plan', () => {
    const prompt = generateMcqPromptFromSpec({ topic: 'Logarithm', count: 3 });
    expect(prompt).not.toContain('KINDS OF EXERCISE TO COVER');
  });
});

describe('the generation prompt is subject-neutral too', () => {
  /**
   * A prompt that teaches with an example from one subject steers every other
   * subject toward it. This one previously used "the range of 4, 6, 8, 10",
   * which is fine advice for statistics and no help at all for arrays, loops
   * or general knowledge.
   */
  const promptFor = (topic: string) =>
    generateMcqPromptFromSpec({ topic, count: 10 }).replace(/\s+/g, ' ');

  it('names no particular subject when asking for variety', () => {
    ['Arrays', 'General knowledge', 'Loops', 'Time and distance'].forEach(
      (topic) => {
        expect(promptFor(topic)).not.toMatch(
          /the range of \d|logarithm|permutation|dataset of|median/i,
        );
      },
    );
  });

  it('describes repetition by what stays the same, not by an example', () => {
    expect(promptFor('Arrays')).toMatch(
      /Swapping the numbers, the names, the objects, the wording or the symbols/i,
    );
  });

  it('lists tasks that exist in any subject', () => {
    const prompt = promptFor('General knowledge');
    expect(prompt).toMatch(/recalling something/i);
    expect(prompt).toMatch(/finding the flaw in a stated conclusion/i);
  });
});
