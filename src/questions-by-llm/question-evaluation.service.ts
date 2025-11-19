import { Inject, Injectable, Logger } from '@nestjs/common';
import { correctAnswers } from 'src/db/schema/correctAns';
import { questionEvaluation } from 'src/db/schema/questionEval';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

@Injectable()
export class QuestionEvaluationService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase
  ) {}
  private readonly logger = new Logger(QuestionEvaluationService.name);
  async saveEvaluations(
    evaluationResponse: any,
    studentId: number,
    aiAssessmentId: number,
  ) {
    try {
      const evaluations = evaluationResponse?.evaluations ?? [];

      if (!Array.isArray(evaluations) || evaluations.length === 0) {
        this.logger.error('No evaluations found in response', evaluations);
        throw new Error('No evaluations found in response');
      }

      const payload = evaluations.map((item) => ({
        question: item.question,
        topic: item.topic,
        difficulty: item.difficulty,
        options: item.options,
        selectedAnswerByStudent: item.selectedAnswerByStudent.id,
        language: item.language,
        explanation: item.explanation,
        questionId: item.id,
        summary: evaluationResponse.summary,
        recommendations: evaluationResponse.recommendations,
        studentId,
        aiAssessmentId,
      }));

      await this.db.insert(questionEvaluation).values(payload);
      return { inserted: payload.length };
    } catch (error) {
      this.logger.error('Error creating evaluation', error);
      throw error;
    }
  }

  // async findOneByStudentId(studentId: number, aiAssessmentId: number) {
  //   const result = await db
  //     .select()
  //     .from(questionEvaluation)
  //     .where(
  //       and(
  //         eq(questionEvaluation.studentId, studentId),
  //         eq(questionEvaluation.aiAssessmentId, aiAssessmentId),
  //       ),
  //     );

  //   return result;
  // }
  async findOneByStudentId(studentId: number, aiAssessmentId: number) {
    const result = await this.db
      .select({
        questionEvaluation: questionEvaluation,
        correctOptionId: correctAnswers.correctOptionId,
      })
      .from(questionEvaluation)
      .leftJoin(
        correctAnswers,
        eq(questionEvaluation.questionId, correctAnswers.questionId),
      )
      .where(
        and(
          eq(questionEvaluation.studentId, studentId),
          eq(questionEvaluation.aiAssessmentId, aiAssessmentId),
        ),
      );

    return result;
  }
}
