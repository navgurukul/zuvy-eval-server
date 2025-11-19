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
import { main, users } from "./parentSchema";

export const studentAssessment = main.table('student_assessment', {
  id: serial('id').primaryKey().notNull(),
  studentId: integer("student_id").notNull().references(() => users.id),
  aiAssessmentId: integer('ai_assessment_id').notNull().references(() => aiAssessment.id, { onDelete: "cascade" }),
  status: integer('status').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => ({
  uniqStudentAssessment: unique("uniq_student_assessment").on(table.studentId, table.aiAssessmentId),
}));