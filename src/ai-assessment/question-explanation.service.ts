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
import { parseQuestionExplanation } from 'src/llm/llm_response_parsers/explanationParser';

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

    const correctOption = qRow.correctOption;
    const correctOptionText = options[String(correctOption)];

    // The stored answer does not name a real option: nothing to explain, and
    // calling the LLM would only invite it to invent one.
    if (typeof correctOptionText !== 'string' || !correctOptionText.trim()) {
      this.logger.warn(
        `Question ${questionId}: stored correctOption ${correctOption} has no matching ` +
          `option text. Serving the fallback and caching nothing.`,
      );
      return {
        questionId,
        explanation: this.fallbackExplanation(correctOption, correctOptionText),
        cached: false,
      };
    }

    const prompt = correctOptionExplanationPrompt({
      question: qRow.question,
      options,
      correctOption,
      correctOptionText,
      language: qRow.language ?? null,
    });

    // TODO: this runs at the provider-wide temperature (0.3, hardcoded in
    // OpenAIProvider) because LlmService.generateCompletion takes no per-call
    // options. This call wants temperature 0, and the GenAI fallback sets no
    // temperature at all. Thread per-call options through LlmService and both
    // providers as a separate change - that code is shared with question
    // generation, which may legitimately want the variance.
    const llmResponse = await this.llmService.generateCompletion(prompt);
    const parsed = parseQuestionExplanation(this.extractLlmText(llmResponse));

    if (!parsed) {
      this.logger.warn(
        `Question ${questionId}: could not parse an explanation from the model. ` +
          `Serving the fallback and caching nothing.`,
      );
      return {
        questionId,
        explanation: this.fallbackExplanation(correctOption, correctOptionText),
        cached: false,
      };
    }

    // The model argued for a different option than the one stored. Never show
    // the student a contradiction: drop the explanation entirely. Repeated
    // warnings for one question id are worth investigating - the stored answer
    // may actually be wrong.
    if (parsed.statedCorrectOption !== correctOption) {
      this.logger.warn(
        `Question ${questionId}: model justified option ${parsed.statedCorrectOption} ` +
          `but the stored correct option is ${correctOption}. Discarding the ` +
          `explanation, serving the fallback and caching nothing. Repeated ` +
          `warnings here may mean the stored answer is wrong.`,
      );
      return {
        questionId,
        explanation: this.fallbackExplanation(correctOption, correctOptionText),
        cached: false,
      };
    }

    const body = this.stripStatedOptionLines(parsed.explanation);

    if (!body) {
      this.logger.warn(
        `Question ${questionId}: explanation was empty after removing option-number ` +
          `lines. Serving the fallback and caching nothing.`,
      );
      return {
        questionId,
        explanation: this.fallbackExplanation(correctOption, correctOptionText),
        cached: false,
      };
    }

    // The option number a student sees always comes from the database.
    const trimmed = `${this.correctOptionHeading(correctOption, correctOptionText)}\n\n${body}`;
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

  /** Rendered from the database, never from the model. */
  private correctOptionHeading(
    correctOption: number,
    correctOptionText?: string,
  ): string {
    return correctOptionText
      ? `Correct option: ${correctOption} - ${correctOptionText}`
      : `Correct option: ${correctOption}`;
  }

  /**
   * Shown when no trustworthy generated explanation is available. Still states
   * the correct answer, because that part is known.
   */
  private fallbackExplanation(
    correctOption: number,
    correctOptionText?: string,
  ): string {
    return (
      `${this.correctOptionHeading(correctOption, correctOptionText)}\n\n` +
      'A detailed explanation is not available for this question right now.'
    );
  }

  /**
   * Belt and braces: the heading is rendered from the database, so drop any
   * "Correct option: ..." or "Correction: ..." line the model emitted anyway
   * rather than showing the student two answers.
   */
  private stripStatedOptionLines(text: string): string {
    return text
      .split('\n')
      .filter((line) => !/^\s*(correct(ed)?\s*option|correction)\s*:/i.test(line))
      .join('\n')
      .trim();
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
