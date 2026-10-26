// src/ai-assessment/llm-mcq-parser.ts
import { z } from 'zod';

const McqItemSchema = z.object({
  question: z.string(),
  // The model's written working. Requested so it solves before keying an
  // answer; used for quality checks and discarded before storage. It is never
  // shown to a student.
  solution: z.string().optional(),
  options: z.record(z.string(), z.string()),
  correctOption: z.number().int(),
  difficulty: z.string().optional(),
  topic: z.string().optional(),
  language: z.string().optional(),
  // Per-question level band: A (most advanced) ... E (most basic).
  // Optional for robustness; we normalize/validate when saving.
  level: z.string().optional(),
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

/**
 * The model declining to generate, rather than failing to.
 *
 * generateMcqPromptFromSpec explicitly asks for this: "If you cannot ensure
 * correctness, return { error: GENERATION_FAILED }". It is the honest answer
 * when a topic is exhausted - a narrow subject with a long do-not-repeat list
 * eventually has nothing new to say - and the model gives it most often on a
 * top-up round asking for the last question or two.
 *
 * It is a distinct type because it is not a parse failure and should not read
 * like one. Treating it as malformed JSON produced a zod schema dump in the
 * logs and killed the whole job, which is the opposite of what a co-operative
 * refusal deserves.
 */
export class GenerationRefusedError extends Error {
  constructor(public readonly reason: string) {
    super(`Model declined to generate: ${reason}`);
    this.name = 'GenerationRefusedError';
  }
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

  // Checked before the schema, or the refusal we asked for reads as a broken
  // reply: it carries no "evaluations" array, so zod reports a missing field
  // and the real message ("I could not do this, and here is why") is lost.
  if (
    candidate &&
    typeof candidate === 'object' &&
    (candidate as Record<string, unknown>).error === 'GENERATION_FAILED'
  ) {
    const reason = (candidate as Record<string, unknown>).reason;
    throw new GenerationRefusedError(
      typeof reason === 'string' && reason.trim() ? reason : 'no reason given',
    );
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
