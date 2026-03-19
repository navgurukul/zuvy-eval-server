// import { encode } from '@toon-format/toon';

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
  } = spec;

  const sections: string[] = [];

  sections.push(`You are an expert assessment author. Generate EXACTLY ${count} multiple-choice questions (MCQs) in strict JSON format.`);
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
  if (difficultyDistribution && Object.keys(difficultyDistribution).length > 0) {
    sections.push(`- Difficulty distribution (percent): ${JSON.stringify(difficultyDistribution)}`);
  }
  if (questionCounts && Object.keys(questionCounts).length > 0) {
    sections.push(`- Question counts by difficulty for this batch: ${JSON.stringify(questionCounts)}. Respect these counts where possible.`);
  }

  if (existingQuestionTexts && existingQuestionTexts.length > 0) {
    sections.push('');
    sections.push(
      'EXISTING QUESTIONS IN THIS DOMAIN (do NOT repeat or closely rephrase these; generate new, distinct questions):',
    );
    existingQuestionTexts.forEach((q, i) => {
      sections.push(`${i + 1}. ${q.trim()}`);
    });
  }

  sections.push('');
  sections.push('OUTPUT REQUIREMENTS:');
  sections.push('1. Output ONLY a single valid JSON object (no markdown, no code fence, no surrounding text).');
  sections.push(`2. Generate exactly ${count} MCQs. All questions must align with the topic and context above.`);
  sections.push('3. Top-level JSON MUST be: { "evaluations": [ /* array of question objects */ ] }');
  sections.push(`4. There MUST be exactly ${count} objects in "evaluations".`);
  sections.push('5. Each question object MUST have:');
  sections.push(
    '   { "question": "<string>", "topic": "<string>", "difficulty": "<easy|medium|hard>", "options": { "1": "<A>", "2": "<B>", "3": "<C>", "4": "<D>" }, "correctOption": <1|2|3|4>, "language": "<string>", "level": "<A+|A|B|C|D|E>" }',
  );
  sections.push(
    '   where "level" is the conceptual depth band for this question: "A+" = highest / exceptional depth, "A" = most advanced, "B" = advanced, "C" = intermediate, "D" = basic, "E" = very basic / foundational.',
  );
  sections.push('6. Options: exactly 4 entries. correctOption must be 1, 2, 3, or 4.');
  sections.push('7. Do NOT include explanations, ids, or extra keys.');
  sections.push('8. If you cannot produce valid JSON, return: { "error": "INVALID_JSON", "reason": "<short reason>" }');
  sections.push('');
  sections.push('Produce the JSON only.');

  return sections.join('\n');
}
