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
import { main } from "./parentSchema";

export const mcqQuestionOptions = main.table("mcq_question_options", {
  id: serial("id").primaryKey().notNull(),
  questionId: integer("question_id").notNull().references(() => questionsByLLM.id, { onDelete: "cascade" }),
  optionText: text("option_text").notNull(),
  optionNumber: integer("option_number").notNull(), // e.g., 1,2,3,4
});