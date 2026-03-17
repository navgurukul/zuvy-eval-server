import {
  integer,
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
  moduleId: integer('module_id')
    .notNull()
    .references(() => zuvyCourseModules.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
});

