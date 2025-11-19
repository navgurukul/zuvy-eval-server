import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Many, relations, sql } from 'drizzle-orm';
import {
  pgTable,
  jsonb,
  pgSchema,
  pgEnum,
  serial,
  varchar,
  timestamp,
  foreignKey,
  integer,
  text,
  unique,
  date,
  bigserial,
  boolean,
  bigint,
  index,
  char,
  json,
  uniqueIndex,
  doublePrecision,
  customType,
  numeric,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { aiAssessment } from "./ai-assessment";
import { main } from "./parentSchema";

export const questionsByLLM = main.table("questions_by_llm", {
  id: serial("id").primaryKey().notNull(),
  topic: varchar("topic", { length: 100 }),
  difficulty: varchar("difficulty", { length: 50 }),
  aiAssessmentId: integer('ai_assessment_id').references(() => aiAssessment.id, { onDelete: "cascade" }).notNull(),
  question: text("question").notNull(),
  language: varchar("language", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
});