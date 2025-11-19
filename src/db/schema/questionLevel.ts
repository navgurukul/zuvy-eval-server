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
import { levels } from "./level";
import { questionsByLLM } from "./questionByLLm";
import { main } from "./parentSchema";

export const questionLevelRelation = main.table("question_level_relation", {
  id: serial("id").primaryKey().notNull(),
  levelId: integer("level_id").notNull().references(() => levels.id),
  questionId: integer("question_id").notNull().references(() => questionsByLLM.id),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow(),
}, (table) => ({
  uniqStudentQuestion: unique("uniq_student_question").on(table.levelId, table.questionId),
}));