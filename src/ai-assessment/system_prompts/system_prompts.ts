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

  sections.push(`You are an expert assessment author and subject-matter expert. Generate EXACTLY ${count} high-quality multiple-choice questions (MCQs) in strict JSON format.`);
  sections.push('');
  
  sections.push('CONTEXT:');
  if (topicName) sections.push(`- Topic name: ${topicName}`);
  if (topicDescription) sections.push(`- Topic description: ${topicDescription}`);
  sections.push(`- Primary topic for this batch: ${topic}`);
  if (subtopics?.length) {
    sections.push(`- Selected subtopics/concepts: ${subtopics.join(', ')}`);
    sections.push('- Generate questions only from the selected subtopics/concepts.');
  }
  if (learningObjectives) sections.push(`- Learning objectives: ${learningObjectives}`);
  if (targetAudience) sections.push(`- Target audience: ${targetAudience}`);
  if (focusAreas) sections.push(`- Focus areas: ${focusAreas}`);
  if (bloomsLevel) sections.push(`- Bloom's taxonomy level: ${bloomsLevel}`);
  if (questionStyle) sections.push(`- Question style: ${questionStyle}`);
  if (hasRequiredDifficultyCounts) {
    sections.push(
      `- REQUIRED DIFFICULTY COUNTS (MANDATORY): Generate exactly ${requiredEasyCount} easy, ${requiredMediumCount} medium, and ${requiredHardCount} hard questions. Missing keys mean 0. Do not exceed or fall short for any level.`
    );
    sections.push(
      `- HARD CONSTRAINT: The difficulty counts must sum to ${count} exactly. If they do not sum to ${count}, return: { "error": "GENERATION_FAILED", "reason": "DIFFICULTY_COUNT_MISMATCH" }.`
    );
  }
  
  if (existingQuestionTexts && existingQuestionTexts.length > 0) {
    sections.push('');
    sections.push('EXISTING QUESTIONS IN THIS DOMAIN (do NOT repeat or closely rephrase these):');
    existingQuestionTexts.forEach((q, i) => {
      sections.push(`${i + 1}. ${q.trim()}`);
    });
  }
  
  sections.push('');
  sections.push('CRITICAL GENERATION RULES (MANDATORY):');
  sections.push('For EACH question, follow this order and WRITE each step down:');
  sections.push('1. Construct a clear, unambiguous question.');
  sections.push(
    '2. Solve it step by step and write the working out in the "solution" field. Do this BEFORE writing any option. Do not solve it silently: the written working is what keeps the answer honest.'
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
  sections.push('   - The question has a definite, verifiable answer (not opinion-based)');
  sections.push('6. If ANY validation fails, DISCARD and regenerate the question.');
  sections.push('7. Do NOT guess. Only include questions where correctness is certain.');
  sections.push('8. NUMERICAL QUESTION PROTOCOL (MANDATORY when arithmetic/calculation is involved):');
  sections.push('   - Solve to a final numeric value internally before writing options.');
  sections.push('   - Use consistent units and conversions; do not mix units across options.');
  sections.push('   - Decide and apply a single rounding rule (or no rounding) consistently.');
  sections.push('   - Ensure exactly one option matches the computed final value under that rule.');
  sections.push('   - Ensure the other three options are definitively incorrect for the same units/rounding rule.');
  sections.push('   - If no option matches exactly, regenerate the entire question and options.');
  
  sections.push('');
  sections.push('SELF-VALIDATION PASS (MANDATORY):');
  sections.push('After writing each question, check it against your own written solution:');
  sections.push('1. Read back the final answer stated at the end of "solution".');
  sections.push('2. Confirm the option "correctOption" points to expresses exactly that answer.');
  sections.push('3. Confirm none of the other three options could also be correct.');
  sections.push('4. If the working and the keyed option disagree, fix the option set or regenerate the question. Never key an option your own solution does not support.');
  sections.push('5. For numerical questions, recompute by a different method and write that second computation into "solution" too. If the two computations disagree, regenerate the question rather than guessing.');
  
  sections.push('');
  sections.push('OUTPUT REQUIREMENTS:');
  sections.push('1. Output ONLY a single valid JSON object (no markdown, no code fence, no surrounding text).');
  sections.push(`2. Generate exactly ${count} MCQs. All questions must align with the topic and context above.`);
  sections.push('3. Top-level JSON MUST be: { "evaluations": [ /* array of question objects */ ] }');
  sections.push(`4. There MUST be exactly ${count} objects in "evaluations".`);
  sections.push('5. Each question object MUST have:');
  sections.push(
    '   { "question": "<string>", "solution": "<your step-by-step working, ending with the final answer>", "options": { "1": "<A>", "2": "<B>", "3": "<C>", "4": "<D>" }, "correctOption": <1|2|3|4>, "topic": "<string>", "difficulty": "<easy|medium|hard>", "language": "<string>", "level": "<A+|A|B|C|D|E>" }'
  );
  sections.push(
    '   The key order matters: write "solution" before "options" and "correctOption". "solution" is used for quality checking and is never shown to students.'
  );
  sections.push(
    '   where "level" is the conceptual depth band for this question: "A+" = highest / exceptional depth, "A" = most advanced, "B" = advanced, "C" = intermediate, "D" = basic, "E" = very basic / foundational.'
  );
  sections.push('6. Options: exactly 4 entries keyed "1" to "4", all non-empty and all different. correctOption must be 1, 2, 3, or 4. These are checked in code and a batch failing them is discarded.');
  sections.push('7. "correctOption" MUST correspond to the correct answer.');
  sections.push('8. For numerical questions, one option must exactly equal the internally computed final answer (same units/rounding), and "correctOption" must point to it.');
  sections.push('9. Options MUST be mutually exclusive and non-overlapping.');
  sections.push(
    '10. Vary the position of the correct answer across this batch: do NOT default to placing it at the same option number (e.g. always "1" or always "2") for most questions. Distribute correctOption roughly evenly across 1, 2, 3, and 4 across the batch.'
  );
  sections.push('11. Do NOT include explanations, ids, or extra keys.');
  sections.push('12. Avoid "All of the above" or "None of the above".');
  sections.push('13. Avoid vague or ambiguous wording.');
  sections.push('14. If you cannot ensure correctness, return: { "error": "GENERATION_FAILED", "reason": "<short reason>" }');
  if (hasRequiredDifficultyCounts) {
    sections.push(
      `15. FINAL BATCH CHECK (MANDATORY): Before output, count difficulties across all generated items. You MUST have easy=${requiredEasyCount}, medium=${requiredMediumCount}, hard=${requiredHardCount}, total=${count}.`
    );
    sections.push(
      '16. If final difficulty counts do not match exactly, regenerate/rebalance before output. Do not output partial or mismatched distribution.'
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
}): string {
  const options = Object.keys(params.options)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => `${k}. ${params.options[k]}`)
    .join('\n');

  return [
    'Solve this multiple-choice question.',
    '',
    'Question:',
    params.question,
    '',
    'Options:',
    options,
    '',
    'Work in this order:',
    '1. Solve the question yourself and state your answer, before considering the options.',
    '2. Then check whether your answer appears among the four options above.',
    '',
    'Respond with ONLY a JSON object of exactly this shape, keys in this order:',
    '{"computedAnswer": "<your answer, stated plainly>", "correctOption": <1, 2, 3, 4 or null>}',
    '',
    'Set "correctOption" to the number of the option matching your computed answer.',
    'Match on value and meaning, not on exact wording, units formatting or rounding style.',
    'Set "correctOption" to null only when none of the four options expresses your answer.',
    'Do not pick the nearest option when none matches: null is the correct response there.',
    '',
    'No explanation, no markdown, no code fences.',
  ].join('\n');
}

/**
 * Reads a verifier reply.
 *
 * Returns null when the reply could not be read at all. A verdict of
 * { correctOption: null } is a real answer ("none of these fit"), not a
 * failure, so the two must never collapse into one: the first means "no
 * signal, keep the question", the second means "drop the question".
 */
export function parseVerifierVerdict(
  text: string | undefined | null,
): { computedAnswer: string | null; correctOption: number | null } | null {
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

  return { computedAnswer, correctOption };
}
