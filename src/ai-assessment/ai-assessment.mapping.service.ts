import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
    ctx: MapQuestionsContext = { orgId: '' },
  ) {
    // Resolve topics outside the DB transaction (may call legacy HTTP APIs).
    const assessment = await this.helpers.loadAssessment(this.db as any, aiAssessmentId);
    const topicNames = await this.helpers.resolveAssessmentTopicNames(assessment, ctx);

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

    const queryVector = await this.helpers.buildScopedQueryVector(assessment, topicNames);

    return this.db.transaction(async (tx) => {
      const totalQuestions = assessment.totalNumberOfQuestions;

      await this.helpers.clearExistingSets(tx, aiAssessmentId);
      const isBaseline = await this.helpers.checkIsBaseline(tx, assessment);

      const { commonPerSet, uniquePerSet, neededTotal } =
        this.helpers.calculateSetSizes(totalQuestions, isBaseline);

      const scopedIds = await this.helpers.searchTopicScoped(
        queryVector,
        topicNames,
        neededTotal,
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
        return this.helpers.createBaselineSet(tx, aiAssessmentId, scopedIds, totalQuestions);
      }

      return this.helpers.createLeveledSets(
        tx, aiAssessmentId, scopedIds, totalQuestions, commonPerSet, uniquePerSet,
      );
    });
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
      throw new NotFoundException(`AI assessment with id=${aiAssessmentId} not found`);
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

    const conditions: any[] = [eq(aiAssessmentQuestionSets.aiAssessmentId, aiAssessmentId)];
    if (filters.setId !== undefined) conditions.push(eq(aiAssessmentQuestionSets.id, filters.setId));
    if (filters.setIndex !== undefined) conditions.push(eq(aiAssessmentQuestionSets.setIndex, filters.setIndex));
    if (filters.levelCode?.trim()) conditions.push(ilike(aiAssessmentQuestionSets.levelCode, filters.levelCode.trim()));
    if (filters.topicName?.trim()) conditions.push(ilike(zuvyQuestions.topicName, filters.topicName.trim()));
    if (filters.difficulty?.trim()) conditions.push(ilike(zuvyQuestions.difficulty, filters.difficulty.trim()));
    if (filters.questionId !== undefined) conditions.push(eq(zuvyQuestions.id, filters.questionId));

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
      .innerJoin(aiAssessmentQuestions, eq(aiAssessmentQuestions.questionSetId, aiAssessmentQuestionSets.id))
      .innerJoin(zuvyQuestions, eq(zuvyQuestions.id, aiAssessmentQuestions.questionId))
      .where(and(...conditions))
      .orderBy(asc(aiAssessmentQuestionSets.setIndex), asc(aiAssessmentQuestions.position));

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
