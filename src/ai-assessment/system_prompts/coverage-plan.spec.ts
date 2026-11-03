import {
  generateMcqPromptFromSpec,
  parseCoveragePlan,
  planCoveragePrompt,
  verifyMcqAnswerPrompt,
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

/**
 * The fairness checks have to hold outside mathematics too.
 *
 * A prompt that teaches with an example from one subject steers every other
 * subject towards it, and the two defects these fields exist to catch are not
 * numeric problems. A question can determine nothing in history ("which of
 * these four years did the treaty hold?" when it held in all of them) and two
 * options can say the same thing in biology as easily as in algebra.
 */
describe('the verifier prompt is subject-neutral', () => {
  const promptFor = (topic: string) =>
    verifyMcqAnswerPrompt({
      question: 'wug lorp blint',
      options: { '1': 'a', '2': 'b', '3': 'c', '4': 'd' },
      topic: { name: topic },
    }).replace(/\s+/g, ' ');

  it('names no subject when explaining what makes a question unfair', () => {
    ['Arrays', 'General knowledge', 'Indian history', 'Photosynthesis'].forEach(
      (topic) => {
        expect(promptFor(topic)).not.toMatch(
          /equation|logarithm|the unknown|both sides|cancel out|arithmetic/i,
        );
      },
    );
  });

  it('asks for both fairness judgements whatever the subject', () => {
    const prompt = promptFor('Indian history');
    expect(prompt).toMatch(/answerIsForced/);
    expect(prompt).toMatch(/optionVerdicts/);
    expect(prompt).toMatch(/judged by itself/i);
  });

  it('asks for them even when no topic is supplied', () => {
    // reviewableTopic returns null for a topic too thin to judge by, and the
    // answer still has to be checked for fairness in that case.
    const prompt = verifyMcqAnswerPrompt({
      question: 'wug lorp blint',
      options: { '1': 'a', '2': 'b', '3': 'c', '4': 'd' },
    });
    expect(prompt).toMatch(/answerIsForced/);
    expect(prompt).toMatch(/optionVerdicts/);
  });
});

/**
 * Planning both axes, not one.
 *
 * A reviewer reading fifty generated questions reported that duplication fell
 * sharply once the context fields were filled in by hand, and returned as soon
 * as a topic name was all the service had. The fields were doing the planning.
 *
 * The planner that existed then named kinds of exercise only, which leaves the
 * subject matter free to repeat: a batch can ask seven different kinds of
 * exercise and still test one idea seven times. Pairing each question with the
 * sub-concept it tests is what closes that, and it is what an instructor was
 * otherwise supplying by hand.
 */
describe('planCoveragePrompt', () => {
  const base = { topic: 'Logarithm', count: 10 };

  it('asks for a pair per question, not a list of one kind of thing', () => {
    const prompt = planCoveragePrompt(base).replace(/\s+/g, ' ');
    expect(prompt).toMatch(/Each is a PAIR/i);
    expect(prompt).toMatch(/SUB-CONCEPT is a distinct idea inside the topic/i);
    expect(prompt).toMatch(/KIND OF EXERCISE is a different thing/i);
  });

  it('requires both columns to vary, not just one', () => {
    const prompt = planCoveragePrompt(base).replace(/\s+/g, ' ');
    expect(prompt).toMatch(/VARY BOTH COLUMNS/i);
    expect(prompt).toMatch(/sharing a sub-concept must not share an exercise/i);
  });

  it('uses sub-concepts the instructor named instead of ignoring them', () => {
    const prompt = planCoveragePrompt({
      ...base,
      subtopics: ['change of base', 'product law'],
    });
    expect(prompt).toContain('change of base, product law');
    expect(prompt.replace(/\s+/g, ' ')).toMatch(/Use these as the sub-concepts/i);
  });

  it('carries the other context fields the planner can use', () => {
    const prompt = planCoveragePrompt({
      ...base,
      topicDescription: 'wug lorp',
      targetAudience: 'blint praxil',
      learningObjectives: 'doved skarn',
    });
    expect(prompt).toContain('wug lorp');
    expect(prompt).toContain('blint praxil');
    expect(prompt).toContain('doved skarn');
  });

  it('shows what already exists so the plan reaches elsewhere', () => {
    const prompt = planCoveragePrompt({
      ...base,
      existingQuestions: ['Evaluate log2(8).'],
    });
    expect(prompt).toContain('Evaluate log2(8).');
    expect(prompt.replace(/\s+/g, ' ')).toMatch(/Reach for ground they do not/i);
  });

  it('carries no example from any particular subject', () => {
    const prompt = planCoveragePrompt({ topic: 'Indian history', count: 8 });
    expect(prompt).not.toMatch(
      /logarithm|log\d|permutation|median|equation|arithmetic/i,
    );
    expect(prompt.replace(/\s+/g, ' ')).toMatch(/recalling or recognising/i);
    expect(prompt.replace(/\s+/g, ' ')).toMatch(
      /finding the flaw in a stated conclusion/i,
    );
  });

  it('says what to do when the topic has fewer sub-concepts than lines', () => {
    expect(planCoveragePrompt(base).replace(/\s+/g, ' ')).toMatch(
      /reuse them with a different exercise each time/i,
    );
  });
});

describe('parseCoveragePlan', () => {
  it('reads the pairs', () => {
    expect(
      parseCoveragePlan(
        '{"plan":[{"subtopic":"wug","exercise":"lorp"},{"subtopic":"blint","exercise":"praxil"}]}',
      ),
    ).toEqual([
      { subtopic: 'wug', exercise: 'lorp' },
      { subtopic: 'blint', exercise: 'praxil' },
    ]);
  });

  it('tolerates code fences', () => {
    const fenced = [
      '```json',
      '{"plan":[{"subtopic":"wug","exercise":"lorp"}]}',
      '```',
    ].join('\n');
    expect(parseCoveragePlan(fenced)).toHaveLength(1);
  });

  it('drops a repeated pair, which asks for the same question twice', () => {
    expect(
      parseCoveragePlan(
        '{"plan":[{"subtopic":"wug","exercise":"lorp"},{"subtopic":"WUG","exercise":"Lorp"},{"subtopic":"wug","exercise":"blint"}]}',
      ),
    ).toEqual([
      { subtopic: 'wug', exercise: 'lorp' },
      { subtopic: 'wug', exercise: 'blint' },
    ]);
  });

  it('keeps one axis repeated as long as the pair differs', () => {
    expect(
      parseCoveragePlan(
        '{"plan":[{"subtopic":"wug","exercise":"lorp"},{"subtopic":"wug","exercise":"praxil"}]}',
      ),
    ).toHaveLength(2);
  });

  it('skips a half-filled cell rather than inventing the other half', () => {
    expect(
      parseCoveragePlan(
        '{"plan":[{"subtopic":"wug"},{"exercise":"lorp"},{"subtopic":"","exercise":"x"},{"subtopic":"a","exercise":"b"}]}',
      ),
    ).toEqual([{ subtopic: 'a', exercise: 'b' }]);
  });

  it('returns nothing rather than throwing on an unreadable reply', () => {
    expect(parseCoveragePlan('not json')).toEqual([]);
    expect(parseCoveragePlan('{"somethingElse":[1]}')).toEqual([]);
    expect(parseCoveragePlan('{"plan":"not an array"}')).toEqual([]);
    expect(parseCoveragePlan(undefined)).toEqual([]);
  });
});

describe('generateMcqPromptFromSpec with a coverage plan', () => {
  const coverage = [
    { subtopic: 'wug', exercise: 'lorp' },
    { subtopic: 'blint', exercise: 'praxil' },
  ];

  it('hands each question its own line, naming both axes', () => {
    const prompt = generateMcqPromptFromSpec({
      topic: 'Logarithm',
      count: 2,
      coverage,
    });

    expect(prompt).toContain('COVERAGE PLAN FOR THIS BATCH');
    expect(prompt).toContain('1. Sub-concept: wug | Exercise: lorp');
    expect(prompt).toContain('2. Sub-concept: blint | Exercise: praxil');
    expect(prompt.replace(/\s+/g, ' ')).toMatch(
      /Write exactly one question for each line/i,
    );
  });

  it('forbids sharing both axes, and asks the surface to vary too', () => {
    const prompt = generateMcqPromptFromSpec({
      topic: 'Logarithm',
      count: 2,
      coverage,
    }).replace(/\s+/g, ' ');

    expect(prompt).toMatch(/No two questions may share both/i);
    expect(prompt).toMatch(/Vary the surface as well as the plan/i);
    expect(prompt).toMatch(/with the numbers swapped are one question/i);
  });


  it('leaves the prompt untouched when there is no plan', () => {
    const prompt = generateMcqPromptFromSpec({ topic: 'Logarithm', count: 3 });
    expect(prompt).not.toContain('COVERAGE PLAN FOR THIS BATCH');
  });
});
