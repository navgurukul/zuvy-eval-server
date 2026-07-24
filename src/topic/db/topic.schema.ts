import {
  integer,
  jsonb,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { main, zuvyBootcamps } from 'src/db/schema/parentSchema';

// Local reference only — owned by another service/module.
export const zuvyCourseModules = main.table('zuvy_course_modules', {
  id: serial('id').primaryKey().notNull(),
  bootcampId: varchar('bootcamp_id')
    .notNull()
    .references(() => zuvyBootcamps.id, { onDelete: 'cascade' }),
});

export const topic = main.table('topic', {
  id: serial('id').primaryKey().notNull(),
  // Topics are tenant-owned. All reads and mutations must be scoped by this value.
  orgId: varchar('org_id', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  subtopic: jsonb('subtopic'),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
});
