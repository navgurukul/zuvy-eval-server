import {
  integer,
  serial,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';
import { main } from 'src/db/schema/parentSchema';
import { aiAssessment } from 'src/db/schema/ai-assessment';

export const aiAssessmentQuestionSets = main.table(
  'ai_assessment_question_sets',
  {
    id: serial('id').primaryKey().notNull(),
    aiAssessmentId: integer('ai_assessment_id')
      .notNull()
      .references(() => aiAssessment.id, { onDelete: 'cascade' }),
    setIndex: integer('set_index').notNull(), // 1–6 (or 1 for baseline)
    label: varchar('label', { length: 32 }).notNull(), // e.g. COMMON, SET_A, ...
    levelCode: varchar('level_code', { length: 8 }), // e.g. A, B, C, D, E
    status: varchar('status', { length: 32 }).notNull().default('draft'), // draft | generated | approved
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
  },
  (table) => ({
    uniqAssessmentSetIndex: unique('uniq_ai_assessment_set_index').on(
      table.aiAssessmentId,
      table.setIndex,
    ),
  }),
);

