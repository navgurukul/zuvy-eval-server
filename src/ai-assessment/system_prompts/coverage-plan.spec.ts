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
    expect(prompt).toMatch(/not the same thing over different numbers/i);
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
