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
import { mcqQuestionOptions } from "./mcqQuestionOpt";
import { main } from "./parentSchema";

export const correctAnswers = main.table("correct_answers", {
  id: serial("id").primaryKey().notNull(),
  questionId: integer("question_id").notNull().references(() => questionsByLLM.id, { onDelete: "cascade" }),
  correctOptionId: integer("correct_option_id").notNull().references(() => mcqQuestionOptions.id, { onDelete: "cascade" }),
});