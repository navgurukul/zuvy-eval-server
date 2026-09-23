import { numeric } from 'drizzle-orm/pg-core';
import {
  integer,
  jsonb,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { main, zuvyBootcamps, zuvyOrganizations } from 'src/db/schema/parentSchema';
import { number } from 'zod';

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
  orgId: integer('org_id').notNull() .references(() => zuvyOrganizations.id, { onDelete: 'cascade' }),
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
