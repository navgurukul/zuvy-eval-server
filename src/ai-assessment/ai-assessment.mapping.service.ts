import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, asc, eq, ilike } from 'drizzle-orm';
import { DRIZZLE_DB } from 'src/db/constant';
import { aiAssessment } from 'src/db/schema/ai-assessment';
import { aiAssessmentQuestionSets } from './ai-assessment.question-set.schema';
import { aiAssessmentQuestions } from './ai-assessment.questions.schema';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';
import {
  AiAssessmentMappingHelpers,
  MapQuestionsContext,
} from './ai-assessment.mapping.helpers';

/**
 * An error's message, with its cause when it has one.
 *
 * Node's fetch reports every network failure as the same "fetch failed" and
 * puts the reason that matters on `cause`: ENOTFOUND for a host that does not
 * resolve, ECONNREFUSED for nothing listening, a connect timeout for a port
 * that is blocked. The stack trace does not include it, so a log line without
 * it says that the request failed and nothing about why. The cause is a
 * network detail - a host and port - and is only ever logged, never returned.
 */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } })
    ?.cause;
  if (!cause || typeof cause !== 'object') return message;
  const detail = [cause.code, cause.message].filter(Boolean).join(' ');
  return detail ? `${message} (cause: ${detail})` : message;
}

@Injectable()
export class AiAssessmentMappingService {
  private readonly logger = new Logger(AiAssessmentMappingService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    private readonly helpers: AiAssessmentMappingHelpers,
  ) {}

  // ─── Map questions into sets ───────────────────────────────────────

  async mapQuestionsForAssessment(
    aiAssessmentId: number,
    ctx: MapQuestionsContext = { orgId: 0 },
  ) {
    // Resolve topics outside the DB transaction (may call legacy HTTP APIs).
    const assessment = await this.helpers.loadAssessment(
      this.db as any,
      aiAssessmentId,
    );
    const topicNames = await this.helpers.resolveAssessmentTopicNames(
      assessment,
      ctx,
    );

    if (topicNames.length === 0) {
      this.logger.warn(
        `No topics resolved for assessment id=${aiAssessmentId} (poolTopics + chapter tags empty)`,
      );
      return {
        statusCode: 200,
        aiAssessmentId,
        setsCreated: 0,
        totalQuestionsPerSet: assessment.totalNumberOfQuestions,
        topicNames: [],
        message:
          'No topics found for this assessment. Provide poolTopics and/or chapterIds with moduleId.',
      };
    }

    const queryVector = await this.atStage(aiAssessmentId, 'embedding', () =>
      this.helpers.buildScopedQueryVector(assessment, topicNames),
    );

    return this.db.transaction(async (tx) => {
      const totalQuestions = assessment.totalNumberOfQuestions;

      await this.helpers.clearExistingSets(tx, aiAssessmentId);
      const isBaseline = await this.helpers.checkIsBaseline(tx, assessment);

      const { commonPerSet, uniquePerSet, neededTotal } =
        this.helpers.calculateSetSizes(totalQuestions, isBaseline);

      // A failure here throws out of the transaction, which rolls back the
      // clearExistingSets above - so a failed remap leaves the assessment's
      // existing sets exactly as they were, never deleted and unreplaced.
      const scopedIds = await this.atStage(aiAssessmentId, 'vector search', () =>
        this.helpers.searchTopicScoped(
          queryVector,
          topicNames,
          neededTotal,
          ctx.orgId,
        ),
      );

      if (scopedIds.length === 0) {
        this.logger.warn(
          `No vector results for assessment id=${aiAssessmentId} topics=${topicNames.join(',')}`,
        );
        throw new NotFoundException({
          statusCode: 404,
          aiAssessmentId,
          isBaseline,
          setsCreated: 0,
          totalQuestionsPerSet: totalQuestions,
          topicNames,
          message:
            'No questions found for this assessment topics. Please generate questions first before mapping.',
        });
      }

      // Reset to draft so the instructor must review before publishing
      const now = new Date().toISOString();
      await tx
        .update(aiAssessment)
        .set({ status: 'draft', publishedAt: null, updatedAt: now } as any)
        .where(eq(aiAssessment.id, aiAssessmentId));

      if (isBaseline) {
        return this.helpers.createBaselineSet(
          tx,
          aiAssessmentId,
          scopedIds,
          totalQuestions,
        );
      }

      return this.helpers.createLeveledSets(
        tx,
        aiAssessmentId,
        scopedIds,
        totalQuestions,
        commonPerSet,
        uniquePerSet,
      );
    });
  }

  /**
   * Runs one step of mapping that depends on an outside service, and turns a
   * failure into an error that says which step it was.
   *
   * Mapping calls OpenAI to embed the assessment and the vector store to find
   * its questions. Either can fail for reasons this service cannot fix - a
   * rejected key, a rate limit, a missing collection or index, a network
   * blip - and those errors are not HttpExceptions, so they reached the client
   * as a bare "Internal server error" with nothing to say what had broken.
   *
   * The full error goes to the log under [map-questions]. The client gets a
   * 503 naming the step, but not the raw message: provider errors can echo
   * part of an API key back. HttpExceptions - a 404 for an assessment with no
   * matching questions, say - are already meaningful and pass through as is.
   */
  private async atStage<T>(
    aiAssessmentId: number,
    stage: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `[map-questions] assessment=${aiAssessmentId} stage=${stage} failed: ` +
          describeError(err),
        err instanceof Error ? err.stack : undefined,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        aiAssessmentId,
        stage,
        message:
          `Mapping failed at the ${stage} step: a service it depends on returned an ` +
          `error. Details are in the server log under [map-questions].`,
      });
    }
  }

  // ─── Instructor preview ────────────────────────────────────────────

  async getInstructorQuestionSetsPreview(
    aiAssessmentId: number,
    filters: {
      setId?: number;
      setIndex?: number;
      levelCode?: string;
      topicName?: string;
      difficulty?: string;
      questionId?: number;
    } = {},
  ) {
    const [assessmentRow] = await this.db
      .select({
        id: aiAssessment.id,
        bootcampId: aiAssessment.bootcampId,
        title: aiAssessment.title,
        description: aiAssessment.description,
        totalNumberOfQuestions: aiAssessment.totalNumberOfQuestions,
        scope: aiAssessment.scope,
        status: aiAssessment.status,
        publishedAt: aiAssessment.publishedAt,
      })
      .from(aiAssessment)
      .where(eq(aiAssessment.id, aiAssessmentId))
      .limit(1);

    if (!assessmentRow) {
      throw new NotFoundException(
        `AI assessment with id=${aiAssessmentId} not found`,
      );
    }

    for (const [name, value] of Object.entries({
      setId: filters.setId,
      setIndex: filters.setIndex,
      questionId: filters.questionId,
    })) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new BadRequestException(`${name} must be a positive integer`);
      }
    }

    const conditions: any[] = [
      eq(aiAssessmentQuestionSets.aiAssessmentId, aiAssessmentId),
    ];
    if (filters.setId !== undefined)
      conditions.push(eq(aiAssessmentQuestionSets.id, filters.setId));
    if (filters.setIndex !== undefined)
      conditions.push(eq(aiAssessmentQuestionSets.setIndex, filters.setIndex));
    if (filters.levelCode?.trim())
      conditions.push(
        ilike(aiAssessmentQuestionSets.levelCode, filters.levelCode.trim()),
      );
    if (filters.topicName?.trim())
      conditions.push(ilike(zuvyQuestions.topicName, filters.topicName.trim()));
    if (filters.difficulty?.trim())
      conditions.push(
        ilike(zuvyQuestions.difficulty, filters.difficulty.trim()),
      );
    if (filters.questionId !== undefined)
      conditions.push(eq(zuvyQuestions.id, filters.questionId));

    const rows = await this.db
      .select({
        setId: aiAssessmentQuestionSets.id,
        setIndex: aiAssessmentQuestionSets.setIndex,
        label: aiAssessmentQuestionSets.label,
        levelCode: aiAssessmentQuestionSets.levelCode,
        setStatus: aiAssessmentQuestionSets.status,
        position: aiAssessmentQuestions.position,
        isCommon: aiAssessmentQuestions.isCommon,
        questionId: zuvyQuestions.id,
        question: zuvyQuestions.question,
        difficulty: zuvyQuestions.difficulty,
        language: zuvyQuestions.language,
        options: zuvyQuestions.options,
        correctOption: zuvyQuestions.correctOption,
        levelId: zuvyQuestions.levelId,
        topicName: zuvyQuestions.topicName,
        topicDescription: zuvyQuestions.topicDescription,
      })
      .from(aiAssessmentQuestionSets)
      .innerJoin(
        aiAssessmentQuestions,
        eq(aiAssessmentQuestions.questionSetId, aiAssessmentQuestionSets.id),
      )
      .innerJoin(
        zuvyQuestions,
        eq(zuvyQuestions.id, aiAssessmentQuestions.questionId),
      )
      .where(and(...conditions))
      .orderBy(
        asc(aiAssessmentQuestionSets.setIndex),
        asc(aiAssessmentQuestions.position),
      );

    type SetAgg = {
      id: number;
      setIndex: number;
      label: string;
      levelCode: string | null;
      status: string;
      questions: Array<{
        position: number;
        isCommon: boolean;
        questionId: number;
        question: string;
        difficulty: string | null;
        language: string | null;
        options: unknown;
        correctOption: number;
        levelId: string | null;
        topicName: string;
        topicDescription: string;
      }>;
    };

    const bySetId = new Map<number, SetAgg>();
    for (const r of rows) {
      let agg = bySetId.get(r.setId);
      if (!agg) {
        agg = {
          id: r.setId,
          setIndex: r.setIndex,
          label: r.label,
          levelCode: r.levelCode,
          status: r.setStatus,
          questions: [],
        };
        bySetId.set(r.setId, agg);
      }
      agg.questions.push({
        position: r.position,
        isCommon: r.isCommon,
        questionId: r.questionId,
        question: r.question,
        difficulty: r.difficulty,
        language: r.language,
        options: r.options,
        correctOption: r.correctOption,
        levelId: r.levelId,
        topicName: r.topicName,
        topicDescription: r.topicDescription,
      });
    }

    const sets = [...bySetId.values()].sort((a, b) => a.setIndex - b.setIndex);

    return {
      aiAssessmentId: assessmentRow.id,
      bootcampId: assessmentRow.bootcampId,
      title: assessmentRow.title,
      description: assessmentRow.description,
      totalNumberOfQuestions: assessmentRow.totalNumberOfQuestions,
      scope: assessmentRow.scope,
      status: assessmentRow.status,
      publishedAt: assessmentRow.publishedAt ?? null,
      isPublished: assessmentRow.status === 'published',
      setCount: sets.length,
      sets,
    };
  }
}
