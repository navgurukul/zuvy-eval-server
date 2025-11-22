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
import { levels } from "./level";
import { main, users, zuvyBootcamps } from "./parentSchema";

export const studentLevelRelation = main.table("student_level_relation", {
  id: serial("id").primaryKey().notNull(),
  studentId: integer("student_id").notNull().references(() => users.id),
  levelId: integer("level_id").notNull().references(() => levels.id),
  aiAssessmentId: integer('ai_assessment_id').references(() => aiAssessment.id),
  bootcampId: integer("bootcamp_id")
      .references(() => zuvyBootcamps.id),
  assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "string" }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow(),
}, (table) => ({
  uniqStudentLevel: unique("uniq_student_assessment").on(table.studentId, table.aiAssessmentId, table.bootcampId),
}));