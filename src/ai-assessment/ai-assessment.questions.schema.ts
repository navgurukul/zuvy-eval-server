import {
  boolean,
  integer,
  serial,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { main } from 'src/db/schema/parentSchema';
import { aiAssessmentQuestionSets } from './ai-assessment.question-set.schema';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';

export const aiAssessmentQuestions = main.table(
  'ai_assessment_questions',
  {
    id: serial('id').primaryKey().notNull(),
    questionSetId: integer('question_set_id')
      .notNull()
      .references(() => aiAssessmentQuestionSets.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => zuvyQuestions.id, { onDelete: 'cascade' }),
    isCommon: boolean('is_common').notNull().default(false),
    position: integer('position').notNull(), // 1..total_number_of_questions
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
    uniqSetQuestion: unique('uniq_ai_assessment_set_question').on(
      table.questionSetId,
      table.questionId,
    ),
    uniqSetPosition: unique('uniq_ai_assessment_set_position').on(
      table.questionSetId,
      table.position,
    ),
  }),
);

