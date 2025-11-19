// src/ai-assessment/llm-mcq-parser.ts
import { z } from 'zod';

const McqItemSchema = z.object({
  question: z.string(),
  options: z.record(z.string(), z.string()),
  correctOption: z.number(),
  difficulty: z.string().optional(),
  topic: z.string().optional(),
  language: z.string().optional(),
});

export const LlmMcqSchema = z.object({
  evaluations: z.array(McqItemSchema),
});

export type LlmMcq = z.infer<typeof LlmMcqSchema>;

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

export function parseLlmMcq(raw: string): LlmMcq {
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

  let candidate: unknown = parsed;
  if (Array.isArray(parsed)) {
    candidate = { evaluations: parsed };
  }

  const result = LlmMcqSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      'Parsed JSON did not match MCQ schema: ' +
        JSON.stringify(result.error.format(), null, 2),
    );
  }

  return result.data;
}
