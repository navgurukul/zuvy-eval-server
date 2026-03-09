import {
  serial,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';
import { main } from 'src/db/schema/parentSchema';

export const zuvyQuestions = main.table('zuvy_questions', {
  id: serial('id').primaryKey().notNull(),

  orgId: varchar('org_id', { length: 255 }),

  domainName: varchar('domain_name', { length: 255 }).notNull(),
  topicName: varchar('topic_name', { length: 255 }).notNull(),
  topicDescription: text('topic_description').notNull(),

  learningObjectives: text('learning_objectives'),
  targetAudience: varchar('target_audience', { length: 255 }),
  focusAreas: text('focus_areas'),
  bloomsLevel: varchar('blooms_level', { length: 50 }),
  questionStyle: varchar('question_style', { length: 50 }),

  question: text('question').notNull(),
  difficulty: varchar('difficulty', { length: 50 }),
  language: varchar('language', { length: 255 }),

  options: jsonb('options').notNull(),
  correctOption: integer('correct_option').notNull(),

  difficultyDistribution: jsonb('difficulty_distribution'),
  questionCounts: jsonb('question_counts'),

  levelId: integer('level_id'),

  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
});
