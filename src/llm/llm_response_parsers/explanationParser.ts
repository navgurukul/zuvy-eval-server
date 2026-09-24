import { z } from 'zod';
import { stripFencesAndNoise } from './evaluationParser';

/**
 * Matches the JSON shape correctOptionExplanationPrompt asks for:
 *   { "statedCorrectOption": 2, "explanation": "..." }
 *
 * statedCorrectOption exists so the caller can check the model against the
 * stored answer. It is never rendered; the option number shown to students is
 * built from the database.
 */
export const QuestionExplanationSchema = z.object({
  statedCorrectOption: z.coerce.number().int(),
  explanation: z.string().min(1),
});

export type QuestionExplanation = z.infer<typeof QuestionExplanationSchema>;

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Returns null rather than throwing: every failure mode here is handled the
 * same way by the caller (log, serve the templated fallback, cache nothing).
 */
export function parseQuestionExplanation(
  raw: string | null,
): QuestionExplanation | null {
  if (!raw?.trim()) return null;

  const jsonChunk = extractFirstJsonObject(stripFencesAndNoise(raw));
  if (!jsonChunk) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonChunk);
  } catch {
    return null;
  }

  const result = QuestionExplanationSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
