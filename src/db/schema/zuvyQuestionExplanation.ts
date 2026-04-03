import { integer, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { main } from './parentSchema';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';

export const zuvyQuestionExplanations = main.table('zuvy_question_explanations', {
  id: serial('id').primaryKey().notNull(),
  questionId: integer('question_id')
    .notNull()
    .unique()
    .references(() => zuvyQuestions.id, { onDelete: 'cascade' }),
  explanation: text('explanation').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});
