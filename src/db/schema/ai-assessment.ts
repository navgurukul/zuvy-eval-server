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
import { main, zuvyBootcamps } from "./parentSchema";
// local reference only — not owned by this service

export const aiAssessment = main.table("ai_assessment", {
  id: serial("id").primaryKey().notNull(),
  bootcampId: integer("bootcamp_id")
    .notNull()
    .references(() => zuvyBootcamps.id),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  topics: jsonb("topics").notNull(),
  audience: jsonb("audience").default(null),
  totalNumberOfQuestions: integer("total_number_of_questions").notNull(),
  totalQuestionsWithBuffer: integer("total_questions_with_buffer").notNull(),
  startDatetime: timestamp('start_datetime', { withTimezone: true, mode: 'string' }),
  endDatetime: timestamp('end_datetime', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
});