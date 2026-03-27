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
import { main, zuvyBootcamps, zuvyModuleChapter } from "./parentSchema";
import { zuvyCourseModules } from "src/topic/db/topic.schema";

export const assessmentScopeEnum = pgEnum('assessment_scope', ['bootcamp', 'domain']);

export const aiAssessment = main.table("ai_assessment", {
  id: serial("id").primaryKey().notNull(),
  bootcampId: integer("bootcamp_id")
    .notNull()
    .references(() => zuvyBootcamps.id),
  chapterId: integer('chapter_id')
    .notNull()
    .references(() => zuvyModuleChapter.id),
  scope: assessmentScopeEnum('scope').notNull().default('bootcamp'),
  domainId: integer('domain_id').references(() => zuvyCourseModules.id),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  audience: jsonb("audience").default(null),
  totalNumberOfQuestions: integer("total_number_of_questions").notNull(),
  totalQuestionsWithBuffer: integer("total_questions_with_buffer").notNull(),
  startDatetime: timestamp('start_datetime', { withTimezone: true, mode: 'string' }),
  endDatetime: timestamp('end_datetime', { withTimezone: true, mode: 'string' }),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
});