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
import { questionsByLLM } from "./questionByLLm";
import { main, users } from "./parentSchema";

export const questionEvaluation = main.table('question_evaluation', {
  id: serial('id').primaryKey().notNull(),
  aiAssessmentId: integer('ai_assessment_id').references(() => aiAssessment.id),
  questionId: integer("question_id").notNull().references(() => questionsByLLM.id),
  question: text('question').notNull(),
  topic: varchar('topic', { length: 255 }),
  difficulty: varchar('difficulty', { length: 50 }),
  options: jsonb('options').notNull(), // { "1": "A", "2": "B", "3": "C", "4": "D" }
  // correctOption: integer('correct_option').notNull(),
  selectedAnswerByStudent: integer('selected_answer_by_student').notNull(),
  language: varchar('language', { length: 50 }),
  status: varchar('status', { length: 50 }),
  explanation: text('explanation'),
  summary: text('summary'),
  recommendations: text('recommendations'),
  studentId: integer("student_id").notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});