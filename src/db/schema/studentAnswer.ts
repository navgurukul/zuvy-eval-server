import {
  serial,
  integer,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { main, users } from './parentSchema';
import { aiAssessment } from './ai-assessment';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';

export const studentAnswers = main.table('student_answers', {
  id: serial('id').primaryKey().notNull(),
  studentId: integer('student_id').notNull().references(() => users.id),
  aiAssessmentId: integer('ai_assessment_id').notNull().references(() => aiAssessment.id, { onDelete: 'cascade' }),
  questionId: integer('question_id').notNull().references(() => zuvyQuestions.id, { onDelete: 'cascade' }),
  selectedOption: integer('selected_option'),
  isCorrect: integer('is_correct').notNull().default(0),
  answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => ({
  uniqStudentQuestion: unique('uniq_student_answer').on(table.studentId, table.aiAssessmentId, table.questionId),
}));
