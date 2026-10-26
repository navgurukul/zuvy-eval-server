// import { encode } from '@toon-format/toon';

/**
 * Asks the model to justify an answer that is already known.
 *
 * The stored correct option is ground truth: the model explains it, it does not
 * adjudicate it. An earlier version of this prompt told the model to re-solve
 * the question and override the stored answer when it disagreed, which produced
 * explanations that announced one option number, argued for another, and then
 * appended a "Correction:" block - all of it rendered to students.
 *
 * "statedCorrectOption" is a consistency check, not a source of truth. The
 * caller renders the option number from the database and discards the whole
 * response when the model's stated option disagrees, so a disagreement can
 * never reach a student. It is logged instead, because a question that keeps
 * failing this check may genuinely have a wrong answer stored.
 */
export function correctOptionExplanationPrompt(params: {
  question: string;
  options: Record<string, string>;
  correctOption: number;
  correctOptionText: string;
  language: string | null;
}) {
  const optionsStr = JSON.stringify(params.options, null, 2);
  const langHint = params.language
    ? `Write the explanation in the same language as the question; question language metadata: ${params.language}.`
    : '';

  return `You are a precise tutor writing a short explanation for a student who has just answered a multiple-choice question.

Question:
${params.question}

Options (the object keys are the option numbers shown to the student, numbered from 1):
${optionsStr}

The correct answer is option ${params.correctOption}: ${JSON.stringify(params.correctOptionText)}

That is the authoritative answer from the question bank. Treat it as a given fact, not as a claim to check. Do not re-solve the question, do not assess whether it is right, and do not argue for a different option. Your only task is to explain why option ${params.correctOption} is correct.

${langHint}

Respond with ONLY a JSON object of exactly this shape:
{
  "statedCorrectOption": <the option number your explanation justifies>,
  "explanation": "<2-4 short sentences explaining why option ${params.correctOption} is correct>"
}

Rules:
- "statedCorrectOption" should be ${params.correctOption}. If you genuinely cannot build a sound explanation for option ${params.correctOption}, put the option number you would justify instead - do not quietly explain a different option.
- Do NOT write "Correct option", "Correction", or any option number prefix inside "explanation". The student is shown the option number separately.
- Do NOT explain why the other options are wrong.
- Do NOT include reasoning, working, or corrections anywhere in the output.
- Output the JSON object only: no surrounding text, no markdown, no code fences.
`;
}

/**
 * The model writes feedback prose; it does NOT decide whether an answer is
 * correct. The caller sets each item's "status" from the same stored-answer
 * comparison that produces the score, so the results screen cannot show a
 * verdict that contradicts the score the student was given.
 */
export function answerEvaluationPrompt(answers: any) {
  // const encodedQuestionsWithAnswers = encode(answers);
  return `
    You are an expert academic evaluator and assessment grader.

    Your task:
    Evaluate each student's submitted answer by comparing it with the correct answer.
    For every question, determine whether the answer is correct or incorrect, explain briefly why, and if incorrect, provide the correct answer.

    Below is the student's submitted data:
    ${JSON.stringify(answers, null, 2)}

    Each item in the input array contains:
    - id
    - question
    - topic
    - difficulty
    - options
    - selectedAnswerByStudent (null means student did not attempt the question)
    - language
    - explanation

    Evaluation rules:
    1. Do NOT judge or state whether the student's answer is correct; correctness is
       determined by the system from the stored answer and is added after your reply.
       Never output a "status" field.
    2. Use the provided correct answer as ground truth. Do not re-solve the question
       and do not argue that a different option is correct.
    3. If selectedAnswerByStudent is null than it means the student did not attempt the question.
    4. When the student's selection differs from the correct answer, explain briefly *why*
       that is a mistake (conceptual, procedural, or factual) and state the correct answer clearly.
    5. For each incorrect answer, include a "practiceLink" field suggesting ONE relevant LeetCode problem URL.
      - Choose dynamically based on the question's topic and difficulty.
      - Use realistic existing LeetCode URLs only; do not invent or fabricate problems.
      - If no relevant match can be inferred, set "practiceLink": null.
    6. Never hallucinate — use only the provided data above.
    7. The output must be **valid JSON only** (no markdown, comments, or text outside JSON).

    Output format (strict JSON):

    {
    "evaluations": [
        {
        "id": "<id>",
        "question": "<full question text>",
        "topic": "<topic>",
        "difficulty": "<difficulty>",
        "options": { <the way it is> },
        "selectedAnswerByStudent": <selected answer>,
        "language": "<language>",
        "explanation": "<1-2 sentences explaining correctness or mistake, and providing correct answer if wrong>"
        }
    ],
    "recommendations": "<brief personalized feedback highlighting strengths, weaknesses, and topics to focus on based on this and previous assessments>",
    "summary": "<2-3 line summary describing overall performance and improvement areas>"
    }

    Guidelines:
    - Keep explanations factual, short, and instructional.
    - Ensure JSON syntax is 100% valid and machine-readable.
    - Do not include any reasoning process or chain-of-thought.
    - Use consistent key naming for all question objects.
    `;
}

export function generateMcqPrompt(
  level,
  levelDescription,
  // audience,
  previous_mcqs_str,
  topicOfCurrentAssessment,
  totalQuestions,
) {
  return `
  """
  You are an assistant that generates EXACTLY 5 computer programming adaptive multiple-choice questions in strict JSON format, based on the student's past performance and the requested level.

  Inputs:
  - level: ${level}
  - level_description: ${levelDescription}
  - previous_mcqs_json: ${previous_mcqs_str}

  OUTPUT REQUIREMENTS:
  1. Output ONLY a single valid JSON object (no surrounding text).
  2. Mcqs must be from the topics as selected. The selected topics are: ${JSON.stringify(topicOfCurrentAssessment)}.
  3. You must generate total of ${totalQuestions} mcqs only. Not more not less.
  4. The top-level JSON object MUST be:
  {
    "evaluations": [ /* array of ${totalQuestions} question objects */ ]
  }
  5. There MUST be exactly ${totalQuestions} objects in evaluations.
  6. Each question object MUST have these fields and types:
    {
      "question": "<full question text>",
      "topic": "<topic>",
      "difficulty": "<difficulty>",
      "options": { "1": "<A>", "2": "<B>", "3": "<C>", "4": "<D>" },
      "correctOption": <1|2|3|4>,
      "language": "<coding language>"
    }
  7. Options must be exactly 4 entries.
  8. correctOption must match one of the options.
  9. Questions must NOT duplicate any question in previous_mcqs_json.
  10. Prefer topics where the student showed weaknesses in past_performance_json.
  11. Include at least 2 distinct topics across the 5 questions.
  12. Adjust difficulty adaptively but respect the provided level_description.
  13. IDs must be unique.
  14. Do NOT include explanations or extra keys.
  15. If you cannot produce valid JSON, return:
    { "error": "INVALID_JSON", "reason": "<short reason>" }

  Now produce the JSON only.
  """
  `.trim();
}

export interface McqGenerationSpec {
  topic: string;
  count: number;
  topicName?: string;
  topicDescription?: string;
  subtopics?: string[];
  learningObjectives?: string;
  targetAudience?: string;
  focusAreas?: string;
  bloomsLevel?: string;
  questionStyle?: string;
  difficultyDistribution?: { easy?: number; medium?: number; hard?: number };
  questionCounts?: { easy?: number; medium?: number; hard?: number };
  batchQuestionCounts?: { easy?: number; medium?: number; hard?: number };
  /**
   * One planned cell per question in this batch: the sub-concept it tests
   * and the exercise it asks for.
   */
  coverage?: CoverageCell[];
}

export function generateMcqPromptFromSpec(
  spec: McqGenerationSpec,
  existingQuestionTexts?: string[],
): string {
  const {
    topic,
    count,
    topicName,
    topicDescription,
    subtopics,
    learningObjectives,
    targetAudience,
    focusAreas,
    bloomsLevel,
    questionStyle,
    difficultyDistribution,
    questionCounts,
    batchQuestionCounts,
  } = spec;
  const requiredEasyCount =
    batchQuestionCounts?.easy ??
    questionCounts?.easy ??
    difficultyDistribution?.easy ??
    0;
  const requiredMediumCount =
    batchQuestionCounts?.medium ??
    questionCounts?.medium ??
    difficultyDistribution?.medium ??
    0;
  const requiredHardCount =
    batchQuestionCounts?.hard ??
    questionCounts?.hard ??
    difficultyDistribution?.hard ??
    0;
  const hasRequiredDifficultyCounts =
    requiredEasyCount + requiredMediumCount + requiredHardCount > 0;

  const sections: string[] = [];

  sections.push(
    `You are an expert assessment author and subject-matter expert. Generate EXACTLY ${count} high-quality multiple-choice questions (MCQs) in strict JSON format.`,
  );
  sections.push('');

  sections.push('CONTEXT:');
  if (topicName) sections.push(`- Topic name: ${topicName}`);
  if (topicDescription)
    sections.push(`- Topic description: ${topicDescription}`);
  sections.push(`- Primary topic for this batch: ${topic}`);
  if (subtopics?.length) {
    sections.push(`- Selected subtopics/concepts: ${subtopics.join(', ')}`);
    sections.push(
      '- Generate questions only from the selected subtopics/concepts.',
    );
  }
  if (spec.coverage?.length) {
    // One line per question, naming both the idea and the task.
    //
    // A list of exercise kinds alone leaves the subject matter free to repeat,
    // and a list of sub-concepts alone leaves the task free to repeat. Pairing
    // them and handing each question its own pair is what stops a batch
    // covering one corner of a topic in seven different ways.
    sections.push('');
    sections.push(
      'COVERAGE PLAN FOR THIS BATCH - one question per line, in this order:',
    );
    spec.coverage.forEach((cell, i) => {
      sections.push(
        `  ${i + 1}. Sub-concept: ${cell.subtopic} | Exercise: ${cell.exercise}`,
      );
    });
    sections.push(
      '- Write exactly one question for each line. Do not write two for one line, and do not skip a line.',
    );
    sections.push(
      '- The sub-concept fixes what the question is ABOUT. The exercise fixes what the student DOES with it.',
    );
    sections.push(
      '- No two questions may share both. Two questions on one sub-concept must ask for different work, and two questions asking the same work must sit on different sub-concepts.',
    );
    sections.push(
      '- Vary the surface as well as the plan: different quantities, different settings, different phrasing. Two questions built from one line of this plan with the numbers swapped are one question, not two.',
    );
    sections.push(
      '- A line you cannot write honestly is better replaced by a question that differs from every other line than by a near-copy of a line above it.',
    );
  }
  if (learningObjectives)
    sections.push(`- Learning objectives: ${learningObjectives}`);
  if (targetAudience) sections.push(`- Target audience: ${targetAudience}`);
  if (focusAreas) sections.push(`- Focus areas: ${focusAreas}`);
  if (bloomsLevel) sections.push(`- Bloom's taxonomy level: ${bloomsLevel}`);
  if (questionStyle) sections.push(`- Question style: ${questionStyle}`);
  if (hasRequiredDifficultyCounts) {
    sections.push(
      `- REQUIRED DIFFICULTY COUNTS (MANDATORY): Generate exactly ${requiredEasyCount} easy, ${requiredMediumCount} medium, and ${requiredHardCount} hard questions. Missing keys mean 0. Do not exceed or fall short for any level.`,
    );
    sections.push(
      `- HARD CONSTRAINT: The difficulty counts must sum to ${count} exactly. If they do not sum to ${count}, return: { "error": "GENERATION_FAILED", "reason": "DIFFICULTY_COUNT_MISMATCH" }.`,
    );
  }

  if (existingQuestionTexts && existingQuestionTexts.length > 0) {
    sections.push('');
    sections.push(
      'EXISTING QUESTIONS IN THIS DOMAIN (do NOT repeat or closely rephrase these):',
    );
    existingQuestionTexts.forEach((q, i) => {
      sections.push(`${i + 1}. ${q.trim()}`);
    });
  }

  sections.push('');
  sections.push('CRITICAL GENERATION RULES (MANDATORY):');
  sections.push(
    'For EACH question, follow this order and WRITE each step down:',
  );
  sections.push('1. Construct a clear, unambiguous question.');
  sections.push(
    '2. Solve it step by step and write the working out in the "solution" field. Do this BEFORE writing any option. Do not solve it silently: the written working is what keeps the answer honest.',
  );
  sections.push('3. State the single correct answer at the end of "solution".');
  sections.push('4. Generate exactly 4 options:');
  sections.push('   - One MUST be the correct answer');
  sections.push('   - Three MUST be plausible but clearly incorrect');
  sections.push('5. Validate strictly:');
  sections.push('   - The correct answer EXACTLY matches one of the options');
  sections.push('   - Only ONE option is correct (no ambiguity)');
  sections.push('   - No duplicate or semantically identical options');
  sections.push('   - No partially correct options');
  sections.push(
    '   - The question has a definite, verifiable answer (not opinion-based)',
  );
  sections.push(
    '6. If ANY validation fails, DISCARD and regenerate the question.',
  );
  sections.push(
    '7. Do NOT guess. Only include questions where correctness is certain.',
  );
  sections.push(
    '8. NUMERICAL QUESTION PROTOCOL (MANDATORY when arithmetic/calculation is involved):',
  );
  sections.push(
    '   - Solve to a final numeric value internally before writing options.',
  );
  sections.push(
    '   - Use consistent units and conversions; do not mix units across options.',
  );
  sections.push(
    '   - Decide and apply a single rounding rule (or no rounding) consistently.',
  );
  sections.push(
    '   - Ensure exactly one option matches the computed final value under that rule.',
  );
  sections.push(
    '   - Ensure the other three options are definitively incorrect for the same units/rounding rule.',
  );
  sections.push(
    '   - If no option matches exactly, regenerate the entire question and options.',
  );

  sections.push('');
  sections.push('SELF-VALIDATION PASS (MANDATORY):');
  sections.push(
    'After writing each question, check it against your own written solution:',
  );
  sections.push(
    '1. Read back the final answer stated at the end of "solution".',
  );
  sections.push(
    '2. Confirm the option "correctOption" points to expresses exactly that answer.',
  );
  sections.push(
    '3. Confirm none of the other three options could also be correct.',
  );
  sections.push(
    '4. If the working and the keyed option disagree, fix the option set or regenerate the question. Never key an option your own solution does not support.',
  );
  sections.push(
    '5. For numerical questions, recompute by a different method and write that second computation into "solution" too. If the two computations disagree, regenerate the question rather than guessing.',
  );

  sections.push('');
  sections.push('OUTPUT REQUIREMENTS:');
  sections.push(
    '1. Output ONLY a single valid JSON object (no markdown, no code fence, no surrounding text).',
  );
  sections.push(
    `2. Generate exactly ${count} MCQs. All questions must align with the topic and context above.`,
  );
  sections.push(
    '3. Top-level JSON MUST be: { "evaluations": [ /* array of question objects */ ] }',
  );
  sections.push(`4. There MUST be exactly ${count} objects in "evaluations".`);
  sections.push('5. Each question object MUST have:');
  sections.push(
    '   { "question": "<string>", "solution": "<your step-by-step working, ending with the final answer>", "options": { "1": "<A>", "2": "<B>", "3": "<C>", "4": "<D>" }, "correctOption": <1|2|3|4>, "topic": "<string>", "difficulty": "<easy|medium|hard>", "language": "<string>", "level": "<A+|A|B|C|D|E>" }',
  );
  sections.push(
    '   The key order matters: write "solution" before "options" and "correctOption". "solution" is used for quality checking and is never shown to students.',
  );
  sections.push(
    '   where "level" is the conceptual depth band for this question: "A+" = highest / exceptional depth, "A" = most advanced, "B" = advanced, "C" = intermediate, "D" = basic, "E" = very basic / foundational.',
  );
  sections.push(
    '6. Options: exactly 4 entries keyed "1" to "4", all non-empty and all different. correctOption must be 1, 2, 3, or 4. These are checked in code and a batch failing them is discarded.',
  );
  sections.push('7. "correctOption" MUST correspond to the correct answer.');
  sections.push(
    '8. For numerical questions, one option must exactly equal the internally computed final answer (same units/rounding), and "correctOption" must point to it.',
  );
  sections.push('9. Options MUST be mutually exclusive and non-overlapping.');
  sections.push(
    '10. Vary the position of the correct answer across this batch: do NOT default to placing it at the same option number (e.g. always "1" or always "2") for most questions. Distribute correctOption roughly evenly across 1, 2, 3, and 4 across the batch.',
  );
  sections.push('11. Do NOT include explanations, ids, or extra keys.');
  sections.push('12. Avoid "All of the above" or "None of the above".');
  sections.push('13. Avoid vague or ambiguous wording.');
  sections.push(
    '13a. VARY THE EXERCISE, NOT THE SURFACE DETAIL. Two questions asking the student to do the same thing are one question, not two, however much the surface changes. Swapping the numbers, the names, the objects, the wording or the symbols does not make a second exercise. At most 2 questions in this batch may ask for the same thing, and that includes the existing questions listed above.',
  );
  sections.push(
    '13b. Reach for a different task, not a different example of the same task. Whatever the subject, these are all separate exercises: recalling something, applying it to a new case, interpreting a given result, comparing two cases, working backwards from an answer, choosing which idea or method fits, and finding the flaw in a stated conclusion. A batch where every question asks the student to carry out one procedure is a batch testing one skill.',
  );
  sections.push(
    '14. If you cannot ensure correctness, return: { "error": "GENERATION_FAILED", "reason": "<short reason>" }',
  );
  if (hasRequiredDifficultyCounts) {
    sections.push(
      `15. FINAL BATCH CHECK (MANDATORY): Before output, count difficulties across all generated items. You MUST have easy=${requiredEasyCount}, medium=${requiredMediumCount}, hard=${requiredHardCount}, total=${count}.`,
    );
    sections.push(
      '16. If final difficulty counts do not match exactly, regenerate/rebalance before output. Do not output partial or mismatched distribution.',
    );
  }

  sections.push('');
  sections.push('Produce the JSON only.');

  return sections.join('\n');
}

/**
 * Asks a model to solve one MCQ from scratch, with no sight of the keyed
 * answer, so its verdict is genuinely independent of the generator's.
 *
 * This is the only check that can catch a generator that reasoned wrongly but
 * consistently. The structural checks in QuestionsProcessor pass happily on a
 * confidently wrong answer, and the generator's own self-validation pass is
 * just more of the same reasoning that produced the error: a batch that keyed
 * 288 for the SCHOOL arrangement question (the answer is 144) had written
 * working agreeing with itself throughout.
 *
 * Wording is taken from scripts/measure-answer-disagreement.js, which is the
 * version the disagreement numbers were measured with, so production and the
 * harness stay comparable. Two details matter and are easy to lose:
 *
 *   - Solving BEFORE looking at the options. Asked the other way round, a
 *     model talks itself into whichever option looks closest.
 *   - "correctOption": null being a real, expected answer. Without an explicit
 *     escape hatch a forced choice hides the case where the right answer is
 *     missing from the four options entirely.
 */
export function verifyMcqAnswerPrompt(params: {
  question: string;
  options: Record<string, string>;
  /**
   * Topic to judge the question against. Omitted when the topic metadata is
   * too thin to judge by, in which case the review fields are not requested
   * at all - see reviewableTopic in QuestionsProcessor.
   */
  topic?: { name: string; description?: string; subtopics?: string[] };
}): string {
  const options = Object.keys(params.options)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => `${k}. ${params.options[k]}`)
    .join('\n');

  const lines = [
    'Solve this multiple-choice question.',
    'Then check that it is a fair question to ask: one answer, and only one option giving it.',
    '',
    'Question:',
    params.question,
    '',
    'Options:',
    options,
    '',
    'Work in this order:',
    '1. Solve the question yourself and state your answer, before considering the options.',
    '2. Decide whether the question pins that answer down. A question is only fair if the',
    '   information it gives forces one answer. If the stated conditions hold for every',
    '   value, or for more than one, the question determines nothing and is unfair however',
    '   plausible one option looks.',
    '3. Then test each of the four options ON ITS OWN. For every option, work out whether',
    '   it is a correct answer to the question. Do not stop at the first option that',
    '   matches: options can be written differently and still be worth the same, and an',
    '   option you have not evaluated is one you cannot call wrong.',
  ];

  if (params.topic) {
    lines.push(
      '4. Only then, judge the question against the topic below. Judge it last: deciding',
      '   what a question is about is easier than solving it, and doing it first invites',
      '   you to reason about the answer from the topic instead of working it out.',
      '',
      `Topic: ${params.topic.name}`,
    );
    if (params.topic.description?.trim()) {
      lines.push(`Topic description: ${params.topic.description.trim()}`);
    }
    if (params.topic.subtopics?.length) {
      lines.push(`Subtopics: ${params.topic.subtopics.join(', ')}`);
    }
  }

  lines.push(
    '',
    'Respond with ONLY a JSON object of exactly this shape, keys in this order:',
    params.topic
      ? '{"working": "<your step by step working>", "computedAnswer": "<your answer, stated plainly>", "answerIsForced": <true or false>, "optionVerdicts": {"1": <true or false>, "2": <true or false>, "3": <true or false>, "4": <true or false>}, "correctOption": <1, 2, 3, 4 or null>, "onTopic": <true or false>, "difficulty": "<easy, medium or hard>"}'
      : '{"working": "<your step by step working>", "computedAnswer": "<your answer, stated plainly>", "answerIsForced": <true or false>, "optionVerdicts": {"1": <true or false>, "2": <true or false>, "3": <true or false>, "4": <true or false>}, "correctOption": <1, 2, 3, 4 or null>}',
    '',
    'Write "working" FIRST and in full. Show every step, name each constraint in the',
    'question and say how you applied it, and restate the question in your own words',
    'before computing. Do not summarise the working or skip to the answer: an answer',
    'produced before the working is reasoning you have not done, and on constrained',
    'counting questions it is usually wrong.',
    'Re-read the question once the working is complete and confirm you used every',
    'condition it states. Missing one is the most common way to get these wrong.',
    '',
    'Set "answerIsForced" to false when the question does not single out one answer: when',
    'what it states is satisfied by every candidate, or by more than one, or when it leaves',
    'out something needed to decide. This is about what the question determines, not about',
    'how hard it is. A question can read as precise and still rule nothing out, because the',
    'condition it rests on holds whichever answer you try; test that by checking whether a',
    'different answer would break anything the question actually says.',
    'Set it to true when the question genuinely forces exactly one answer.',
    '',
    'Set each entry of "optionVerdicts" to true when THAT option, judged by itself, is a',
    'correct answer to the question, and false when it is not. Judge meaning, not',
    'appearance: two options written differently can say the same thing, and both are then',
    'true. An option that amounts to a correct answer counts as true, however it is put.',
    'Give a verdict for all four options. More than one true is a real and expected answer',
    'here, not a mistake to avoid - a question with two correct options is exactly what this',
    'field exists to report.',
    '',
    'Set "correctOption" to the number of the option matching your computed answer.',
    'Match on value and meaning, not on exact wording, units formatting or rounding style.',
    'Set "correctOption" to null only when none of the four options expresses your answer.',
    'Do not pick the nearest option when none matches: null is the correct response there.',
  );

  if (params.topic) {
    lines.push(
      '',
      'Set "onTopic" to false only when the question tests a different subject area than the',
      'topic above. A question that is narrower, broader or unusually phrased is still on',
      'topic. Judge the subject matter, not the wording or the quality.',
      'Set "difficulty" to how hard the question is for the average student studying this topic.',
    );
  }

  lines.push('', 'No explanation, no markdown, no code fences.');

  return lines.join('\n');
}

/**
 * Reads a verifier reply.
 *
 * Returns null when the reply could not be read at all. A verdict of
 * { correctOption: null } is a real answer ("none of these fit"), not a
 * failure, so the two must never collapse into one: the first means "no
 * signal, keep the question", the second means "drop the question".
 */
export function parseVerifierVerdict(text: string | undefined | null): {
  computedAnswer: string | null;
  correctOption: number | null;
  /**
   * How many of the four options the reviewer judged correct, or null when it
   * did not say.
   *
   * Two correct options is not a wrong answer - the keyed one may be perfectly
   * right - so it is invisible to correctOption and needs its own count. A
   * change-of-base question shipped with log10(8)/log10(4) keyed correct and
   * log4(8)/log4(4) sitting beside it, worth the same thing because log4(4) is
   * 1. Whichever the student picks, one of them is marked wrong.
   */
  correctOptionCount: number | null;
  /**
   * Whether the question forces one answer, or null when the reviewer did not
   * say.
   *
   * A question can have a correct-looking key and still determine nothing. One
   * shipped asking for the base a in log_a(100) + log_a(0.01), keyed 10: by the
   * product law the left side is log_a(1), which is 0 for every valid base, so
   * a is never pinned down and 10 is no more correct than any other answer.
   */
  answerIsForced: boolean | null;
  /** null when not requested or not answered, never a parse failure. */
  onTopic: boolean | null;
  difficulty: 'easy' | 'medium' | 'hard' | null;
} | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!('correctOption' in parsed)) return null;

  const raw = parsed.correctOption;
  let correctOption: number | null = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 4) return null;
    correctOption = n;
  }

  const computedAnswer =
    typeof parsed.computedAnswer === 'string' ? parsed.computedAnswer : null;

  // The review fields are additive. A reply missing them is a complete answer
  // to the question that matters, so it must not fail the whole verdict and
  // turn a usable answer check into "unverified".
  const onTopic = typeof parsed.onTopic === 'boolean' ? parsed.onTopic : null;

  const answerIsForced =
    typeof parsed.answerIsForced === 'boolean' ? parsed.answerIsForced : null;

  // Counted only when the reviewer gave a verdict on every option. A partial
  // map cannot show that a second option is correct - the unjudged ones might
  // be - so counting one from it would invent a reason to keep a question
  // rather than a reason to drop it.
  let correctOptionCount: number | null = null;
  const verdicts = parsed.optionVerdicts;
  if (verdicts && typeof verdicts === 'object' && !Array.isArray(verdicts)) {
    const values = ['1', '2', '3', '4'].map((k) => verdicts[k]);
    if (values.every((v) => typeof v === 'boolean')) {
      correctOptionCount = values.filter(Boolean).length;
    }
  }

  const rawDifficulty = String(parsed.difficulty ?? '')
    .trim()
    .toLowerCase();
  const difficulty =
    rawDifficulty === 'easy' ||
    rawDifficulty === 'medium' ||
    rawDifficulty === 'hard'
      ? rawDifficulty
      : null;

  return {
    computedAnswer,
    correctOption,
    correctOptionCount,
    answerIsForced,
    onTopic,
    difficulty,
  };
}

/**
 * One planned question: the idea it tests, and what the student does with it.
 *
 * Variety needs both. A batch can ask seven different kinds of exercise and
 * still test one idea seven times, and it can cover seven ideas while asking
 * the student to do the same thing each time. Planning only one of the two
 * leaves the other free to repeat, which is what a reviewer reading fifty
 * questions on one topic actually sees.
 */
export type CoverageCell = { subtopic: string; exercise: string };

/**
 * Asks the model to plan what each question in a batch will cover, as pairs.
 *
 * This replaces planning a flat list of exercise kinds. A topic name alone is
 * not a plan, and a model given one pads: asked for fifty questions on a
 * single topic with nothing else filled in, it returns the same handful of
 * exercises with the numbers changed. Testers confirmed the other direction
 * too - when the context fields were filled in by hand, duplication dropped
 * sharply. The fields were doing the planning, and the service has to do it
 * itself, because an instructor cannot be asked to write a long brief every
 * time.
 *
 * Sub-concepts supplied by an instructor are used as the first column rather
 * than replacing the plan. Supplying them used to switch planning off
 * entirely, which meant the richest input produced the least structure.
 *
 * Asking for the whole request rather than one batch is what keeps the jobs
 * of one request apart. A request for fifty questions is five jobs of ten, and
 * five jobs that each plan ten cells on a narrow topic plan the same ten.
 */
export function planCoveragePrompt(params: {
  topic: string;
  topicDescription?: string;
  /** Sub-concepts from the request, when the instructor named any. */
  subtopics?: string[];
  learningObjectives?: string;
  targetAudience?: string;
  /** Cells to plan: the whole request, not this batch. */
  count: number;
  existingQuestions?: string[];
}): string {
  const lines = [`You are planning an assessment on: ${params.topic}`];

  if (params.topicDescription?.trim()) {
    lines.push(`Topic description: ${params.topicDescription.trim()}`);
  }
  if (params.targetAudience?.trim()) {
    lines.push(`Audience: ${params.targetAudience.trim()}`);
  }
  if (params.learningObjectives?.trim()) {
    lines.push(`Learning objectives: ${params.learningObjectives.trim()}`);
  }

  const given = (params.subtopics ?? [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);

  if (given.length) {
    lines.push('');
    lines.push(`Sub-concepts to cover: ${given.join(', ')}`);
    lines.push(
      'Use these as the sub-concepts. Split one into narrower parts if that is',
      'needed to fill the plan, and add another only if these cannot carry it.',
    );
  }

  if (params.existingQuestions?.length) {
    lines.push('');
    lines.push('Questions that already exist for this topic:');
    params.existingQuestions.slice(0, 40).forEach((q, i) => {
      lines.push(`${i + 1}. ${String(q).trim()}`);
    });
    lines.push('');
    lines.push('Those already cover their own ground. Reach for ground they do not.');
  }

  lines.push(
    '',
    `Plan ${params.count} questions. Each is a PAIR: the sub-concept it tests,`,
    'and the kind of exercise it asks for.',
    '',
    'A SUB-CONCEPT is a distinct idea inside the topic - a part of it a student',
    'could understand while misunderstanding another part. Name the real',
    'divisions of this topic. Restating the topic in other words is not a',
    'sub-concept, and neither is a difficulty level.',
    '',
    'A KIND OF EXERCISE is a different thing the student has to DO. Changing the',
    'numbers, the names, the objects, the symbols or the wording gives you the',
    'same kind again, not a new one. These are separate kinds in any subject:',
    '  - recalling or recognising something',
    '  - applying it to a case the student has not seen',
    '  - interpreting a result or a statement given to them',
    '  - comparing two cases and saying how they differ',
    '  - working backwards from an answer to what must have produced it',
    '  - choosing which idea, rule or method fits a situation',
    '  - finding the flaw in a stated conclusion',
    '',
    'Name both in the language of THIS topic rather than repeating those words.',
    '',
    'VARY BOTH COLUMNS. Two lines sharing a sub-concept must not share an',
    'exercise, and two lines sharing an exercise must not share a sub-concept.',
    'A plan that repeats a pair is a plan for duplicate questions.',
    '',
    'Spread across the sub-concepts before returning to any of them, so the',
    'early lines do not all sit in one corner of the topic.',
    '',
    'If the topic genuinely has fewer sub-concepts than lines, reuse them with',
    'a different exercise each time rather than inventing ones that are the',
    'same idea renamed.',
    '',
    'Respond with ONLY a JSON object of exactly this shape:',
    '{"plan": [{"subtopic": "<short phrase>", "exercise": "<short phrase>"}]}',
    '',
    'No explanation, no markdown, no code fences.',
  );

  return lines.join('\n');
}

/**
 * Reads a coverage plan.
 *
 * Returns an empty array rather than throwing: a plan improves generation and
 * is not a precondition for it, so an unreadable one leaves generation exactly
 * as it was.
 *
 * Repeated pairs are dropped. A plan listing one pair twice asks for the same
 * question twice, which is the thing the plan exists to prevent.
 */
export function parseCoveragePlan(
  text: string | undefined | null,
): CoverageCell[] {
  if (!text) return [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  const plan = parsed?.plan;
  if (!Array.isArray(plan)) return [];

  const seen = new Set<string>();
  const out: CoverageCell[] = [];
  plan.forEach((cell) => {
    const subtopic = String(cell?.subtopic ?? '').trim();
    const exercise = String(cell?.exercise ?? '').trim();
    if (!subtopic || !exercise) return;
    const key = `${subtopic.toLowerCase()}|${exercise.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ subtopic, exercise });
  });
  return out;
}
