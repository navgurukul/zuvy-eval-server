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

/**
 * Why an explanation was degraded to the templated fallback. Emitted verbatim
 * as reason=<value> on every [explanation-degraded] line, so each path can be
 * grepped and alerted on separately.
 */
type ExplanationFailure =
  | 'missing_option_text'
  | 'provider_backoff'
  | 'provider_failure'
  | 'failure_threshold'
  | 'unparseable'
  | 'option_mismatch'
  | 'empty_after_strip';

/** How long to stop calling the LLM after the provider fails. */
const PROVIDER_BACKOFF_MS = 60_000;

/** Content failures per question before the LLM stops being called for it. */
const MAX_CONTENT_FAILURES = 3;

@Injectable()
export class QuestionExplanationService {
  private readonly logger = new Logger(QuestionExplanationService.name);

  /**
   * Nothing is cached when validation fails, so without these two bounds every
   * page view of a bad question would call the LLM again.
   *
   * Both are in-memory and per-instance: they reset on restart and are not
   * shared between containers. That is deliberate - they exist to damp
   * hammering, not to be an accurate global tally, and avoiding a new table
   * keeps this self-contained.
   */
  private providerBackoffUntil = 0;
  private readonly contentFailures = new Map<number, number>();

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
      return this.degraded(
        questionId,
        correctOption,
        correctOptionText,
        'missing_option_text',
      );
    }

    // The provider failed recently. Don't retry once per page view.
    const backoffRemaining = this.providerBackoffUntil - Date.now();
    if (backoffRemaining > 0) {
      return this.degraded(
        questionId,
        correctOption,
        correctOptionText,
        'provider_backoff',
        `retryInMs=${backoffRemaining}`,
      );
    }

    // A question that keeps producing suspect content will not start producing
    // good content on the next view: stop paying for it and leave a trail.
    const priorFailures = this.contentFailures.get(questionId) ?? 0;
    if (priorFailures >= MAX_CONTENT_FAILURES) {
      return this.degraded(
        questionId,
        correctOption,
        correctOptionText,
        'failure_threshold',
        `failures=${priorFailures} (no further LLM calls for this question until ` +
          `restart; its stored answer may be wrong)`,
      );
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
    const rawText = this.extractLlmText(llmResponse);

    // LlmService.generateCompletion swallows provider errors and returns
    // undefined, and OpenAIProvider returns an empty string on error. Either
    // means the provider failed rather than that the content was bad, so back
    // off globally instead of counting it against this question.
    if (!rawText?.trim()) {
      this.providerBackoffUntil = Date.now() + PROVIDER_BACKOFF_MS;
      return this.degraded(
        questionId,
        correctOption,
        correctOptionText,
        'provider_failure',
        `backoffMs=${PROVIDER_BACKOFF_MS}`,
      );
    }

    const parsed = parseQuestionExplanation(rawText);

    if (!parsed) {
      return this.degraded(
        questionId,
        correctOption,
        correctOptionText,
        'unparseable',
        `failures=${this.recordContentFailure(questionId)}`,
      );
    }

    // The model argued for a different option than the one stored. Never show
    // the student a contradiction: drop the explanation entirely. Repeated
    // hits on one question id are worth investigating - the stored answer may
    // actually be wrong.
    if (parsed.statedCorrectOption !== correctOption) {
      return this.degraded(
        questionId,
        correctOption,
        correctOptionText,
        'option_mismatch',
        `stated=${parsed.statedCorrectOption} stored=${correctOption} ` +
          `failures=${this.recordContentFailure(questionId)}`,
      );
    }

    const body = this.stripStatedOptionLines(parsed.explanation);

    if (!body) {
      return this.degraded(
        questionId,
        correctOption,
        correctOptionText,
        'empty_after_strip',
        `failures=${this.recordContentFailure(questionId)}`,
      );
    }

    // Usable explanation: this question is healthy again.
    this.contentFailures.delete(questionId);

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

  /**
   * One greppable line per degraded explanation:
   *   [explanation-degraded] questionId=<id> reason=<type> [detail]
   *
   * Provider failures are an infrastructure problem and logged at error level;
   * content failures point at the question's stored data and are warnings.
   *
   * There is no error-reporting SDK in this repo (no Sentry, Bugsnag or global
   * exception filter). When one is added, the provider branch below is the
   * single hook point for routing these to it.
   */
  private logDegraded(
    questionId: number,
    reason: ExplanationFailure,
    detail?: string,
  ): void {
    const line =
      `[explanation-degraded] questionId=${questionId} reason=${reason}` +
      (detail ? ` ${detail}` : '');

    if (reason === 'provider_failure' || reason === 'provider_backoff') {
      this.logger.error(line);
    } else {
      this.logger.warn(line);
    }
  }

  /** Logs the failure and returns the fallback response. Caches nothing. */
  private degraded(
    questionId: number,
    correctOption: number,
    correctOptionText: string | undefined,
    reason: ExplanationFailure,
    detail?: string,
  ): { questionId: number; explanation: string; cached: boolean } {
    this.logDegraded(questionId, reason, detail);
    return {
      questionId,
      explanation: this.fallbackExplanation(correctOption, correctOptionText),
      cached: false,
    };
  }

  /** Counts a suspect-content failure and returns this question's new total. */
  private recordContentFailure(questionId: number): number {
    const next = (this.contentFailures.get(questionId) ?? 0) + 1;
    this.contentFailures.set(questionId, next);
    return next;
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
