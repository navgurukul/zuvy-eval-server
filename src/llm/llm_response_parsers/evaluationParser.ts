// src/ai-assessment/llm-eval-parser.ts
import { z } from 'zod';

/**
 * Matches the JSON structure the system prompt requests:
 * {
 *   evaluations: [ { id, question, topic, difficulty, options, correctOption, selectedAnswerByStudent, language, status, explanation } ],
 *   recommendations: "...",
 *   summary: "..."
 * }
 */

const OptionSchema = z.object({
  id: z.union([z.string(), z.number()]),
  questionId: z.union([z.string(), z.number()]),
  optionText: z.string(),
  optionNumber: z.number(),
});

const EvaluationItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  question: z.string(),
  topic: z.string().optional(),
  difficulty: z.string().optional(),
  options: z.array(OptionSchema),
  selectedAnswerByStudent: OptionSchema,
  language: z.string().optional(),
  status: z.enum(['correct', 'incorrect']),
  explanation: z.string().min(1),
});

export const LlmEvaluationSchema = z.object({
  evaluations: z.array(EvaluationItemSchema),
  recommendations: z.string().optional(),
  summary: z.string().optional(),
});

export type LlmEvaluation = z.infer<typeof LlmEvaluationSchema>;

/* reuse your helpers but exported so service can import them */
export function stripFencesAndNoise(raw: string) {
  if (!raw) return raw;
  raw = raw.replace(/```json\n?([\s\S]*?)```/g, '$1');
  raw = raw.replace(/```\n?([\s\S]*?)```/g, '$1');
  raw = raw.replace(/```json\s*([\s\S]*?)\s*```/g, '$1');
  raw = raw.replace(/^[\s\S]*?(?=\{|\[)/, (m) =>
    m.includes('{') || m.includes('[') ? m : '',
  );
  return raw.trim();
}

function extractFirstJson(raw: string) {
  // find the first { or [, then try to capture balanced JSON for either object or array
  const startObj = raw.indexOf('{');
  const startArr = raw.indexOf('[');
  let start = -1;
  let openChar = '';
  if (startArr !== -1 && (startArr < startObj || startObj === -1)) {
    start = startArr;
    openChar = '[';
  } else if (startObj !== -1) {
    start = startObj;
    openChar = '{';
  } else {
    return null;
  }

  let depth = 0;
  const pair = openChar === '{' ? ['{', '}'] : ['[', ']'];
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === pair[0]) depth++;
    else if (ch === pair[1]) depth--;
    if (depth === 0) {
      return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseLlmEvaluation(raw: string): LlmEvaluation {
  const cleaned = stripFencesAndNoise(raw);
  const jsonChunk = extractFirstJson(cleaned);
  if (!jsonChunk) {
    throw new Error('No JSON object/array found in LLM response.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonChunk);
  } catch (err) {
    throw new Error(
      'Failed to parse JSON from LLM output: ' + (err as Error).message,
    );
  }

  // If the LLM returned an array (older variants), try to wrap it
  let candidate: unknown = parsed;
  if (Array.isArray(parsed)) {
    candidate = { evaluations: parsed };
  }

  const result = LlmEvaluationSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      'Parsed JSON did not match evaluation schema: ' +
        JSON.stringify(result.error.format(), null, 2),
    );
  }

  return result.data;
}
