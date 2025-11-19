// import { z } from "zod";

// const QuestionSchema = z.object({
//   topic: z.string().min(1),
//   difficulty: z.string().min(1),
//   question: z.string().min(1),
//   options: z.array(z.string().min(0)).length(4),
//   answer: z.string().min(1),
// });
// export const QuestionsArraySchema = z.array(QuestionSchema);

// export type Question = z.infer<typeof QuestionSchema>;

// function stripFencesAndNoise(raw: string) {
//   if (!raw) return raw;
//   raw = raw.replace(/```json\n?([\s\S]*?)```/g, "$1");
//   raw = raw.replace(/```\n?([\s\S]*?)```/g, "$1");
//   raw = raw.replace(/```json\s*([\s\S]*?)\s*```/g, "$1");
//   raw = raw.replace(/^[\s\S]*?(?=\[)/, (m) => (m.includes("[") ? m : ""));
//   return raw.trim();
// }

// function extractFirstJsonArray(raw: string) {
//   const start = raw.indexOf("[");
//   if (start === -1) return null;

//   let depth = 0;
//   for (let i = start; i < raw.length; i++) {
//     const ch = raw[i];
//     if (ch === "[") depth++;
//     else if (ch === "]") depth--;
//     if (depth === 0) {
//       return raw.slice(start, i + 1);
//     }
//   }
//   return null;
// }

// export function parseLLMQuestions(raw: string) : Question[] {
//   const cleaned = stripFencesAndNoise(raw);

//   const jsonChunk = extractFirstJsonArray(cleaned);
//   if (!jsonChunk) {
//     throw new Error("No JSON array found in LLM response.");
//   }

//   let parsed: unknown;
//   try {
//     parsed = JSON.parse(jsonChunk);
//   } catch (err) {
//     throw new Error("Failed to parse JSON. Raw extracted chunk may be malformed: " + (err as Error).message);
//   }

//   const result = QuestionsArraySchema.safeParse(parsed);
//   if (!result.success) {
//     throw new Error("Parsed JSON did not match required schema: " + JSON.stringify(result.error.format(), null, 2));
//   }

//   return result.data;
// }

