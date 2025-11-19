import { pgTable, serial, text, integer, jsonb, timestamp, varchar } from "drizzle-orm/pg-core";
import { main } from "./parentSchema";
import { aiAssessment } from "./ai-assessment";

export const llmUsage = main.table("llm_usage", {
  id: serial("id").primaryKey(),
  aiAssessmentId: integer('ai_assessment_id').references(() => aiAssessment.id, { onDelete: "cascade" }).notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  prompt: text("prompt").notNull(),
  responseText: text("response_text").notNull(),

  latencyMs: integer("latency_ms").notNull(),

  usage: jsonb("usage"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type LLMUsage = typeof llmUsage.$inferSelect;
export type InsertLLMUsage = typeof llmUsage.$inferInsert;
