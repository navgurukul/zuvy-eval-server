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
import { main } from "./parentSchema";


export const levels = main.table("levels", {
  id: serial("id").primaryKey().notNull(),
  grade: varchar("grade", { length: 5 }).notNull(), // e.g. A+, A, B...
  scoreRange: varchar("score_range", { length: 50 }).notNull(), // e.g. ">= 90", "80-89"
  scoreMin: integer("score_min"), // optional numeric range start
  scoreMax: integer("score_max"), // optional numeric range end
  hardship: varchar("hardship", { length: 20 }), // "+20%", etc.
  meaning: text("meaning"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
}, (table) => ({
  uniqGrade: unique("uniq_level_grade").on(table.grade),
}));