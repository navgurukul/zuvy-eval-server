// import { encode } from '@toon-format/toon';

export function correctOptionExplanationPrompt(params: {
  question: string;
  options: Record<string, string>;
  correctOption: number;
  language: string | null;
}) {
  const optionsStr = JSON.stringify(params.options, null, 2);
  const langHint = params.language
    ? `Use the same language as the question when appropriate; question language metadata: ${params.language}.`
    : '';

  return `You are a precise tutor. Solve this multiple-choice question yourself and identify the truly correct option from the options provided.

Question:
${params.question}

Options (object keys are option numbers as strings):
${optionsStr}

Provided correct option (may be wrong; do NOT trust blindly): ${params.correctOption}

${langHint}

Rules:
- First determine the correct option by solving the question.
- If the provided correct option conflicts with your solution, ignore it and use your solved answer.
- Output ONLY:
  1) "Correct option: <option_number>"
  2) A brief explanation of why that option is correct.
- Do NOT explain why other options are wrong.
- Keep the explanation concise to save tokens (2-4 short sentences).
- Output plain text only (no JSON, no markdown code fences, no extra sections).
`;
}

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
    1. Mark "status" as "correct" if the student's selected answer is correct.
    2. Mark "status" as "incorrect" otherwise.
    3. If selectedAnswerByStudent is null than it means the student did not attempt the question.
    4. For incorrect answers, explain briefly *why* (conceptual, procedural, or factual error) and mention the correct answer clearly.
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
        "status": "<correct | incorrect>",
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
  domainName?: string;
  topicName?: string;
  topicDescription?: string;
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
    domainName,
    topicName,
    topicDescription,
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
  if (domainName) sections.push(`- Domain: ${domainName}`);
  if (topicName) sections.push(`- Topic name: ${topicName}`);
  if (topicDescription) sections.push(`- Topic description: ${topicDescription}`);
  sections.push(`- Primary topic for this batch: ${topic}`);
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
  sections.push('For EACH question, you MUST follow this internal process BEFORE finalizing:');
  sections.push('1. Construct a clear, unambiguous question.');
  sections.push('2. Solve the question step-by-step internally.');
  sections.push('3. Identify the SINGLE correct answer.');
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
  sections.push('After generating each question, re-evaluate it independently:');
  sections.push('1. Re-solve the question again.');
  sections.push('2. Confirm that the selected correctOption is still correct.');
  sections.push('3. Ensure none of the other options could be correct.');
  sections.push('4. If inconsistency is found, regenerate the question.');
  sections.push('5. Only include questions that pass this second validation.');
  sections.push('6. For numerical questions, independently recompute once more (different order/method internally) and confirm the same final answer maps to the same option.');
  
  sections.push('');
  sections.push('OUTPUT REQUIREMENTS:');
  sections.push('1. Output ONLY a single valid JSON object (no markdown, no code fence, no surrounding text).');
  sections.push(`2. Generate exactly ${count} MCQs. All questions must align with the topic and context above.`);
  sections.push('3. Top-level JSON MUST be: { "evaluations": [ /* array of question objects */ ] }');
  sections.push(`4. There MUST be exactly ${count} objects in "evaluations".`);
  sections.push('5. Each question object MUST have:');
  sections.push(
    '   { "question": "<string>", "topic": "<string>", "difficulty": "<easy|medium|hard>", "options": { "1": "<A>", "2": "<B>", "3": "<C>", "4": "<D>" }, "correctOption": <1|2|3|4>, "language": "<string>", "level": "<A+|A|B|C|D|E>" }'
  );
  sections.push(
    '   where "level" is the conceptual depth band for this question: "A+" = highest / exceptional depth, "A" = most advanced, "B" = advanced, "C" = intermediate, "D" = basic, "E" = very basic / foundational.'
  );
  sections.push('6. Options: exactly 4 entries. correctOption must be 1, 2, 3, or 4.');
  sections.push('7. "correctOption" MUST correspond to the correct answer.');
  sections.push('8. For numerical questions, one option must exactly equal the internally computed final answer (same units/rounding), and "correctOption" must point to it.');
  sections.push('9. Options MUST be mutually exclusive and non-overlapping.');
  sections.push('10. Do NOT include explanations, ids, or extra keys.');
  sections.push('11. Avoid "All of the above" or "None of the above".');
  sections.push('12. Avoid vague or ambiguous wording.');
  sections.push('13. If you cannot ensure correctness, return: { "error": "GENERATION_FAILED", "reason": "<short reason>" }');
  if (hasRequiredDifficultyCounts) {
    sections.push(
      `14. FINAL BATCH CHECK (MANDATORY): Before output, count difficulties across all generated items. You MUST have easy=${requiredEasyCount}, medium=${requiredMediumCount}, hard=${requiredHardCount}, total=${count}.`
    );
    sections.push(
      '15. If final difficulty counts do not match exactly, regenerate/rebalance before output. Do not output partial or mismatched distribution.'
    );
  }
  
  sections.push('');
  sections.push('Produce the JSON only.');
  
  return sections.join('\n');
}
