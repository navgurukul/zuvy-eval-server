import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from 'src/db/constant';
import { aiAssessment } from 'src/db/schema/ai-assessment';
import { aiAssessmentQuestionSets } from './ai-assessment.question-set.schema';
import { aiAssessmentQuestions } from './ai-assessment.questions.schema';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';
import { topic, zuvyCourseModules } from 'src/topic/db/topic.schema';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { VectorService } from 'src/vector/vector.service';

export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

const QDRANT_QUESTIONS_COLLECTION = 'QUESTIONS';

export const SAFETY_FACTOR = 2;

export const SET_DEFINITIONS = [
  { setIndex: 1, label: 'SET_E', levelCode: 'E', questionLevelId: 'E' },
  { setIndex: 2, label: 'SET_D', levelCode: 'D', questionLevelId: 'D' },
  { setIndex: 3, label: 'SET_C', levelCode: 'C', questionLevelId: 'C' },
  { setIndex: 4, label: 'SET_B', levelCode: 'B', questionLevelId: 'B' },
  { setIndex: 5, label: 'SET_A', levelCode: 'A', questionLevelId: 'A' },
  { setIndex: 6, label: 'SET_A_PLUS', levelCode: 'A+', questionLevelId: 'A+' },
] as const;

@Injectable()
export class AiAssessmentMappingHelpers {
  private readonly logger = new Logger(AiAssessmentMappingHelpers.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    private readonly embeddingsService: EmbeddingsService,
    private readonly vectorService: VectorService,
  ) {}

  // ─── Load & validate ───────────────────────────────────────────────

  async loadAssessment(tx: Tx, aiAssessmentId: number) {
    const [assessment] = await tx
      .select()
      .from(aiAssessment)
      .where(eq(aiAssessment.id, aiAssessmentId))
      .limit(1);

    if (!assessment) {
      throw new NotFoundException(`AI assessment with id=${aiAssessmentId} not found`);
    }
    if (!assessment.totalNumberOfQuestions || assessment.totalNumberOfQuestions <= 0) {
      throw new BadRequestException('totalNumberOfQuestions must be > 0 to map questions');
    }
    return assessment;
  }

  // ─── Idempotent cleanup ────────────────────────────────────────────

  async clearExistingSets(tx: Tx, aiAssessmentId: number) {
    const existingSets = await tx
      .select({ id: aiAssessmentQuestionSets.id })
      .from(aiAssessmentQuestionSets)
      .where(eq(aiAssessmentQuestionSets.aiAssessmentId, aiAssessmentId));

    if (existingSets.length > 0) {
      const setIds = existingSets.map((s) => s.id);
      await tx.delete(aiAssessmentQuestions).where(inArray(aiAssessmentQuestions.questionSetId, setIds as number[]));
      await tx.delete(aiAssessmentQuestionSets).where(eq(aiAssessmentQuestionSets.aiAssessmentId, aiAssessmentId));
    }

    await tx
      .update(aiAssessment)
      .set({ publishedAt: null, updatedAt: new Date().toISOString() } as any)
      .where(eq(aiAssessment.id, aiAssessmentId));
  }

  // ─── Baseline detection ────────────────────────────────────────────

  async checkIsBaseline(tx: Tx, assessment: any): Promise<boolean> {
    if (assessment.scope === 'bootcamp') {
      const [first] = await tx
        .select({ id: aiAssessment.id })
        .from(aiAssessment)
        .where(and(
          eq(aiAssessment.bootcampId, assessment.bootcampId),
          eq(aiAssessment.scope, 'bootcamp' as any),
        ))
        .orderBy(aiAssessment.id)
        .limit(1);
      return first?.id === assessment.id;
    }

    if (assessment.scope === 'domain') {
      const domainId = assessment.domainId ?? null;
      const [first] = await tx
        .select({ id: aiAssessment.id })
        .from(aiAssessment)
        .where(and(
          eq(aiAssessment.bootcampId, assessment.bootcampId),
          eq(aiAssessment.scope, 'domain' as any),
          domainId === null ? sql`1=0` : eq(aiAssessment.domainId, domainId),
        ))
        .orderBy(aiAssessment.id)
        .limit(1);
      return first?.id === assessment.id;
    }

    return false;
  }

  // ─── Embedding query ───────────────────────────────────────────────

  async buildQueryVector(assessment: any): Promise<number[]> {
    const audienceText =
      typeof assessment.audience === 'string'
        ? assessment.audience
        : JSON.stringify(assessment.audience ?? '');

    const queryText = [assessment.title ?? '', assessment.description ?? '', audienceText]
      .filter(Boolean)
      .join(' ');

    return this.embeddingsService.embed(queryText);
  }

  // ─── Set size math ─────────────────────────────────────────────────

  calculateSetSizes(totalQuestions: number, isBaseline: boolean) {
    const commonPerSet = Math.round(totalQuestions * 0.4);
    const uniquePerSet = totalQuestions - commonPerSet;
    const distinctNeeded = commonPerSet + uniquePerSet * 6;
    const neededTotal = isBaseline ? totalQuestions : distinctNeeded * SAFETY_FACTOR;
    return { commonPerSet, uniquePerSet, neededTotal };
  }

  // ─── Qdrant filter for domain scope ────────────────────────────────

  async resolveDomainFilter(
    tx: Tx,
    assessment: any,
  ): Promise<Record<string, any> | undefined> {
    if (assessment.scope !== 'domain' || !assessment.domainId) return undefined;

    const domainTopics = await tx
      .select({ name: topic.name })
      .from(topic)
      .where(eq(topic.moduleId, assessment.domainId));

    if (domainTopics.length === 0) return undefined;

    const [sample] = await tx
      .select({ domainName: zuvyQuestions.domainName })
      .from(zuvyQuestions)
      .where(inArray(zuvyQuestions.topicName, domainTopics.map((t) => t.name)))
      .limit(1);

    return sample?.domainName ? { domainName: sample.domainName } : undefined;
  }

  // ─── Vector search ─────────────────────────────────────────────────

  async searchQuestions(
    queryVector: number[],
    limit: number,
    filter?: Record<string, any>,
  ): Promise<number[]> {
    const results = await this.vectorService.search({
      collectionName: QDRANT_QUESTIONS_COLLECTION,
      queryVector,
      limit,
      filter,
    });

    return results
      .map((r) => Number(r.payload?.questionId ?? r.id))
      .filter((id) => Number.isFinite(id));
  }

  // ─── Per-domain Qdrant search for bootcamp scope ────────────────────

  async searchPerDomain(
    tx: Tx,
    bootcampId: number,
    queryVector: number[],
    neededTotal: number,
  ): Promise<number[]> {
    const domainNames = await this.resolveBootcampDomainNames(tx, bootcampId);
    if (domainNames.length === 0) return [];

    const perDomain = Math.ceil(neededTotal / domainNames.length);
    const seen = new Set<number>();
    const result: number[] = [];

    for (const domainName of domainNames) {
      const ids = await this.searchQuestions(queryVector, perDomain, { domainName });
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          result.push(id);
        }
      }
    }

    return result.slice(0, neededTotal);
  }

  // ─── Resolve bootcamp domain names ──────────────────────────────────

  private async resolveBootcampDomainNames(tx: Tx, bootcampId: number): Promise<string[]> {
    const modules = await tx
      .select({ moduleId: zuvyCourseModules.id })
      .from(zuvyCourseModules)
      .where(eq(zuvyCourseModules.bootcampId, String(bootcampId)));

    if (modules.length === 0) return [];

    const moduleIds = modules.map((m) => m.moduleId);
    const allTopics = await tx
      .select({ name: topic.name })
      .from(topic)
      .where(inArray(topic.moduleId, moduleIds));

    if (allTopics.length === 0) return [];

    const samples = await tx
      .selectDistinct({ domainName: zuvyQuestions.domainName })
      .from(zuvyQuestions)
      .where(inArray(zuvyQuestions.topicName, allTopics.map((t) => t.name)));

    return samples.map((s) => s.domainName).filter(Boolean);
  }

  // ─── Baseline set creation ─────────────────────────────────────────

  async createBaselineSet(
    tx: Tx,
    aiAssessmentId: number,
    scopedIds: number[],
    totalQuestions: number,
  ) {
    const [insertedSet] = await tx
      .insert(aiAssessmentQuestionSets)
      .values({
        aiAssessmentId,
        setIndex: 1,
        label: 'BASELINE',
        levelCode: null,
        status: 'generated',
      } as any)
      .returning({ id: aiAssessmentQuestionSets.id });

    const baselineIds = scopedIds.slice(0, totalQuestions);

    const existing = await tx
      .select({ id: zuvyQuestions.id })
      .from(zuvyQuestions)
      .where(inArray(zuvyQuestions.id, baselineIds));

    const existingSet = new Set(existing.map((q) => q.id));
    const finalIds = baselineIds.filter((id) => existingSet.has(id));

    if (finalIds.length > 0) {
      await tx.insert(aiAssessmentQuestions).values(
        finalIds.map((id, idx) => ({
          questionSetId: insertedSet.id,
          questionId: id,
          isCommon: false,
          position: idx + 1,
        })) as any,
      );
    }

    return { aiAssessmentId, isBaseline: true, setsCreated: 1, totalQuestionsPerSet: totalQuestions };
  }

  // ─── Non-baseline (6 leveled sets) ─────────────────────────────────

  async createLeveledSets(
    tx: Tx,
    aiAssessmentId: number,
    scopedIds: number[],
    totalQuestions: number,
    commonPerSet: number,
    uniquePerSet: number,
  ) {
    const insertedSets = await tx
      .insert(aiAssessmentQuestionSets)
      .values(
        SET_DEFINITIONS.map((s) => ({
          aiAssessmentId,
          setIndex: s.setIndex,
          label: s.label,
          levelCode: s.levelCode,
          status: 'generated',
        })) as any,
      )
      .returning({ id: aiAssessmentQuestionSets.id, setIndex: aiAssessmentQuestionSets.setIndex });

    const setIdByIndex = new Map<number, number>();
    insertedSets.forEach((s) => setIdByIndex.set(s.setIndex, s.id));

    const candidates = await tx
      .select({ id: zuvyQuestions.id, levelId: zuvyQuestions.levelId })
      .from(zuvyQuestions)
      .where(inArray(zuvyQuestions.id, scopedIds));

    const byId = new Map(candidates.map((c) => [c.id, (c.levelId as string) ?? null]));
    const orderedIds = scopedIds.filter((id) => byId.has(id));

    const commonIds = orderedIds.slice(0, commonPerSet);
    const remainingIds = orderedIds.slice(commonPerSet);

    const commonRows: any[] = [];
    for (const def of SET_DEFINITIONS) {
      const setId = setIdByIndex.get(def.setIndex)!;
      for (let i = 0; i < commonIds.length; i++) {
        commonRows.push({ questionSetId: setId, questionId: commonIds[i], isCommon: true, position: i + 1 });
      }
    }
    if (commonRows.length > 0) {
      await tx.insert(aiAssessmentQuestions).values(commonRows);
    }

    for (const def of SET_DEFINITIONS) {
      const setId = setIdByIndex.get(def.setIndex)!;

      const exact = remainingIds.filter((id) => byId.get(id) === def.questionLevelId);
      let chosen = exact.slice(0, uniquePerSet);

      if (chosen.length < uniquePerSet) {
        const fallback = remainingIds.filter((id) => !chosen.includes(id));
        chosen = chosen.concat(fallback.slice(0, uniquePerSet - chosen.length));
        if (chosen.length < uniquePerSet) {
          this.logger.warn(
            `Not enough unique questions for set=${def.levelCode} (assessment=${aiAssessmentId}); need=${uniquePerSet}, got=${chosen.length}`,
          );
        }
      }

      if (chosen.length > 0) {
        await tx.insert(aiAssessmentQuestions).values(
          chosen.map((id, idx) => ({
            questionSetId: setId,
            questionId: id,
            isCommon: false,
            position: commonPerSet + idx + 1,
          })) as any,
        );
      }
    }

    return {
      aiAssessmentId,
      isBaseline: false,
      setsCreated: SET_DEFINITIONS.length,
      totalQuestionsPerSet: totalQuestions,
      commonPerSet,
      uniquePerSet,
    };
  }
}
