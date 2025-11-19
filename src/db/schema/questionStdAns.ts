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
import { questionsByLLM } from "./questionByLLm";
import { correctAnswers } from "./correctAns";
import { main, users } from "./parentSchema";

export const questionStudentAnswerRelation = main.table("question_student_answer_relation", {
  id: serial("id").primaryKey().notNull(),
  studentId: integer("student_id").notNull().references(() => users.id),
  questionId: integer("question_id").notNull().references(() => questionsByLLM.id),
  answer: integer("answer").notNull().references(() => correctAnswers.id),
  answeredAt: timestamp("answered_at", { withTimezone: true, mode: "string" }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
}, (table) => ({
  uniqStudentQuestionAnswer: unique("uniq_student_question_answer").on(table.studentId, table.questionId),
}));