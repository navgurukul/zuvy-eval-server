import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from 'src/db/constant';
import { studentAssessment } from 'src/db/schema/stdAssessment';
import { aiAssessmentQuestions } from './ai-assessment.questions.schema';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';
import { zuvyQuestionExplanations } from 'src/db/schema/zuvyQuestionExplanation';
import { LlmService } from 'src/llm/llm.service';
import { correctOptionExplanationPrompt } from './system_prompts/system_prompts';

@Injectable()
export class QuestionExplanationService {
  private readonly logger = new Logger(QuestionExplanationService.name);

  constructor(
    private readonly llmService: LlmService,
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
  ) {}

  private async assertStudentQuestionInAssessment(
    studentId: number,
    assessmentId: number,
    questionId: number,
  ) {
    const [assignment] = await this.db
      .select({
        questionSetId: studentAssessment.questionSetId,
      })
      .from(studentAssessment)
      .where(
        and(
          eq(studentAssessment.studentId, studentId),
          eq(studentAssessment.aiAssessmentId, assessmentId),
        ),
      )
      .limit(1);

    if (!assignment) {
      throw new NotFoundException('No assessment assignment found for this student');
    }

    if (!assignment.questionSetId) {
      throw new BadRequestException(
        'No question set has been assigned for this assessment yet',
      );
    }

    const [inSet] = await this.db
      .select({ questionId: aiAssessmentQuestions.questionId })
      .from(aiAssessmentQuestions)
      .where(
        and(
          eq(aiAssessmentQuestions.questionSetId, assignment.questionSetId),
          eq(aiAssessmentQuestions.questionId, questionId),
        ),
      )
      .limit(1);

    if (!inSet) {
      throw new ForbiddenException(
        'This question is not part of your assessment attempt',
      );
    }
  }

  async getOrCreateQuestionExplanation(
    studentId: number,
    assessmentId: number,
    questionId: number,
  ): Promise<{ questionId: number; explanation: string; cached: boolean }> {
    if (studentId == null || Number.isNaN(Number(studentId))) {
      throw new UnauthorizedException();
    }

    await this.assertStudentQuestionInAssessment(
      studentId,
      assessmentId,
      questionId,
    );

    const [cached] = await this.db
      .select({
        explanation: zuvyQuestionExplanations.explanation,
      })
      .from(zuvyQuestionExplanations)
      .where(eq(zuvyQuestionExplanations.questionId, questionId))
      .limit(1);

    if (cached?.explanation) {
      return {
        questionId,
        explanation: cached.explanation,
        cached: true,
      };
    }

    const [qRow] = await this.db
      .select({
        question: zuvyQuestions.question,
        options: zuvyQuestions.options,
        correctOption: zuvyQuestions.correctOption,
        language: zuvyQuestions.language,
      })
      .from(zuvyQuestions)
      .where(eq(zuvyQuestions.id, questionId))
      .limit(1);

    if (!qRow) {
      throw new NotFoundException('Question not found');
    }

    const options =
      qRow.options && typeof qRow.options === 'object' && !Array.isArray(qRow.options)
        ? (qRow.options as Record<string, string>)
        : {};

    const prompt = correctOptionExplanationPrompt({
      question: qRow.question,
      options,
      correctOption: qRow.correctOption,
      language: qRow.language ?? null,
    });

    const llmResponse = await this.llmService.generateCompletion(prompt);
    const explanationText = this.extractLlmText(llmResponse);

    if (!explanationText?.trim()) {
      throw new InternalServerErrorException(
        'Could not generate an explanation. Please try again.',
      );
    }

    const trimmed = explanationText.trim();
    const now = new Date().toISOString();

    try {
      await this.db
        .insert(zuvyQuestionExplanations)
        .values({
          questionId,
          explanation: trimmed,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: zuvyQuestionExplanations.questionId });
    } catch (err) {
      this.logger.warn(
        `Insert explanation for question ${questionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const [after] = await this.db
      .select({
        explanation: zuvyQuestionExplanations.explanation,
      })
      .from(zuvyQuestionExplanations)
      .where(eq(zuvyQuestionExplanations.questionId, questionId))
      .limit(1);

    if (!after?.explanation) {
      throw new InternalServerErrorException(
        'Failed to persist explanation. Please try again.',
      );
    }

    return {
      questionId,
      explanation: after.explanation,
      cached: false,
    };
  }

  private extractLlmText(llmResponse: any): string | null {
    if (!llmResponse) return null;
    const responseText = llmResponse.text;
    if (responseText && typeof responseText === 'string') return responseText;
    if (typeof llmResponse === 'object') {
      return (
        llmResponse.text ??
        llmResponse.message?.content ??
        llmResponse.content ??
        llmResponse.response ??
        llmResponse.output ??
        null
      );
    }
    return null;
  }
}
