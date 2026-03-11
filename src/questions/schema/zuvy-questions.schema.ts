import { integer, jsonb, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { main } from 'src/db/schema/parentSchema';

export const zuvyQuestions = main.table('zuvy_questions', {
  id: serial('id').primaryKey().notNull(),

  orgId: varchar('orgId', { length: 255 }),

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

  // Per-question conceptual level band: A (most advanced) ... E (most basic).
  levelId: varchar('level_id', { length: 1 }),

  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
});

/**
 * Outbox for question indexing in Qdrant.
 * Each event represents "questionId needs (re)indexing".
 */
export const questionIndexOutbox = main.table('question_index_outbox', {
  id: serial('id').primaryKey().notNull(),
  questionId: integer('question_id').notNull(),
  /** User id (e.g. JWT sub) who requested this generation; used to send WS notification only to that user. */
  requestedByUserId: varchar('requested_by_user_id', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'string',
  }).defaultNow(),
});
