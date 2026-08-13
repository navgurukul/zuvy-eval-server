import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from 'src/db/constant';
import { aiAssessment } from 'src/db/schema/ai-assessment';
import { aiAssessmentQuestionSets } from './ai-assessment.question-set.schema';
import { aiAssessmentQuestions } from './ai-assessment.questions.schema';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { VectorService } from 'src/vector/vector.service';
import { TopicService } from 'src/topic/topic.service';

export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export type MapQuestionsContext = {
  orgId: string;
  authorization?: string;
};

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
    private readonly topicService: TopicService,
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
    const [first] = await tx
      .select({ id: aiAssessment.id })
      .from(aiAssessment)
      .where(eq(aiAssessment.bootcampId, assessment.bootcampId))
      .orderBy(aiAssessment.id)
      .limit(1);
    return first?.id === assessment.id;
  }

  // ─── Topic resolution (poolTopics + chapter tags) ──────────────────

  async resolveAssessmentTopicNames(
    assessment: any,
    ctx: MapQuestionsContext,
  ): Promise<string[]> {
    const poolNames = this.normalizeNames(
      (Array.isArray(assessment.poolTopics) ? assessment.poolTopics : []).map(
        (t: { name?: string }) => t?.name,
      ),
    );

    const chapterIds = Array.isArray(assessment.chapterIds)
      ? (assessment.chapterIds as number[]).filter(
          (id) => typeof id === 'number' && Number.isFinite(id),
        )
      : [];

    let chapterTopicNames: string[] = [];
    if (chapterIds.length > 0) {
      const moduleId = assessment.moduleId ?? null;
      if (moduleId == null) {
        this.logger.warn(
          `Assessment id=${assessment.id} has chapterIds but no moduleId; skipping chapter tag resolve`,
        );
      } else if (!ctx.orgId?.trim()) {
        this.logger.warn(
          `Assessment id=${assessment.id}: orgId missing; skipping chapter tag resolve`,
        );
      } else {
        try {
          const tags = await this.topicService.resolveTagsFromChapterIds(
            ctx.orgId,
            {
              chapterIds,
              bootcampId: assessment.bootcampId,
              moduleId: Number(moduleId),
            },
            ctx.authorization,
          );
          chapterTopicNames = this.normalizeNames(
            (tags ?? []).map((t) => t.topicName),
          );
        } catch (err) {
          this.logger.warn(
            `Failed to resolve chapter tags for assessment id=${assessment.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return this.normalizeNames([...poolNames, ...chapterTopicNames]);
  }

  // ─── Embedding query ───────────────────────────────────────────────

  async buildQueryVector(assessment: any): Promise<number[]> {
    return this.embeddingsService.embed(
      [assessment.title ?? '', assessment.description ?? '', this.audienceToText(assessment.audience)]
        .filter(Boolean)
        .join(' '),
    );
  }

  async buildScopedQueryVector(
    assessment: any,
    topicNames: string[],
  ): Promise<number[]> {
    const audienceText =
      typeof assessment.audience === 'string'
        ? assessment.audience
        : JSON.stringify(assessment.audience ?? '');
    const topicContext =
      topicNames.length > 0
        ? `Topics in scope: ${topicNames.slice(0, 80).join(', ')}`
        : '';

    const queryText = [assessment.title ?? '', assessment.description ?? '', audienceText, topicContext]
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

  /** Search QUESTIONS collection evenly across topic names (no domain filter). */
  async searchTopicScoped(
    queryVector: number[],
    topicNames: string[],
    neededTotal: number,
  ): Promise<number[]> {
    return this.searchEvenlyByTopics(queryVector, topicNames, neededTotal, {});
  }

  private async searchEvenlyByTopics(
    queryVector: number[],
    topicNames: string[],
    totalNeeded: number,
    baseFilter: Record<string, any>,
  ): Promise<number[]> {
    const topics = this.normalizeNames(topicNames);
    if (topics.length === 0 || totalNeeded <= 0) return [];

    const perTopic = this.allocateEvenly(totalNeeded, topics.length);
    const seen = new Set<number>();
    const result: number[] = [];
    const deficits: Array<{ topicName: string; missing: number }> = [];

    for (let i = 0; i < topics.length; i++) {
      const topicName = topics[i];
      const quota = perTopic[i];
      if (quota <= 0) continue;

      const ids = await this.searchQuestions(queryVector, quota, {
        ...baseFilter,
        topic: topicName,
      });

      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          result.push(id);
        }
      }

      if (ids.length < quota) {
        deficits.push({ topicName, missing: quota - ids.length });
      }
    }

    for (const deficit of deficits) {
      if (result.length >= totalNeeded) break;
      const extra = await this.searchQuestions(
        queryVector,
        Math.max(deficit.missing * 3, deficit.missing),
        {
          ...baseFilter,
          topic: deficit.topicName,
        },
      );
      for (const id of extra) {
        if (result.length >= totalNeeded) break;
        if (!seen.has(id)) {
          seen.add(id);
          result.push(id);
        }
      }
    }

    return result.slice(0, totalNeeded);
  }

  private allocateEvenly(total: number, buckets: number): number[] {
    if (buckets <= 0) return [];
    const base = Math.floor(total / buckets);
    const remainder = total % buckets;
    return Array.from({ length: buckets }, (_, i) => base + (i < remainder ? 1 : 0));
  }

  private normalizeNames(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
      const t = (v ?? '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  private audienceToText(audience: unknown): string {
    return typeof audience === 'string' ? audience : JSON.stringify(audience ?? '');
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
      .select({
        id: zuvyQuestions.id,
        levelId: zuvyQuestions.levelId,
        difficulty: zuvyQuestions.difficulty,
      })
      .from(zuvyQuestions)
      .where(inArray(zuvyQuestions.id, scopedIds));

    const byId = new Map(
      candidates.map((c) => [
        c.id,
        {
          levelId: (c.levelId as string) ?? null,
          difficulty: (c.difficulty as string) ?? null,
        },
      ]),
    );
    const orderedCandidates = scopedIds
      .map((id, index) => {
        const meta = byId.get(id);
        if (!meta) return null;
        return {
          id,
          index,
          levelId: meta.levelId,
          difficulty: meta.difficulty,
        };
      })
      .filter(Boolean) as Array<{
      id: number;
      index: number;
      levelId: string | null;
      difficulty: string | null;
    }>;

    const commonIds = orderedCandidates.slice(0, commonPerSet).map((c) => c.id);
    const remainingCandidates = orderedCandidates.slice(commonPerSet);

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
      const chosen = this.selectUniqueForSet(
        remainingCandidates,
        def.questionLevelId,
        def.levelCode,
        uniquePerSet,
      );
      if (chosen.length < uniquePerSet) {
        this.logger.warn(
          `Not enough unique questions for set=${def.levelCode} (assessment=${aiAssessmentId}); need=${uniquePerSet}, got=${chosen.length}`,
        );
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

  private selectUniqueForSet(
    candidates: Array<{
      id: number;
      index: number;
      levelId: string | null;
      difficulty: string | null;
    }>,
    targetLevelId: string,
    setLevelCode: string,
    uniquePerSet: number,
  ) {
    const quotas = this.getDifficultyQuotasForSet(setLevelCode, uniquePerSet);
    const byDifficulty: Record<'easy' | 'medium' | 'hard', typeof candidates> = {
      easy: [],
      medium: [],
      hard: [],
    };

    for (const candidate of candidates) {
      const d = this.normalizeDifficulty(candidate.difficulty);
      if (d) byDifficulty[d].push(candidate);
    }

    const sortByLevelThenIndex = (
      a: { levelId: string | null; index: number },
      b: { levelId: string | null; index: number },
    ) => {
      const aLevelScore = a.levelId === targetLevelId ? 1 : 0;
      const bLevelScore = b.levelId === targetLevelId ? 1 : 0;
      if (aLevelScore !== bLevelScore) return bLevelScore - aLevelScore;
      return a.index - b.index;
    };

    (Object.keys(byDifficulty) as Array<'easy' | 'medium' | 'hard'>).forEach((key) => {
      byDifficulty[key].sort(sortByLevelThenIndex);
    });

    const chosenIds: number[] = [];
    const chosenSet = new Set<number>();
    const takeFromBucket = (bucket: Array<{ id: number }>, count: number) => {
      for (const c of bucket) {
        if (count <= 0) break;
        if (chosenSet.has(c.id)) continue;
        chosenSet.add(c.id);
        chosenIds.push(c.id);
        count -= 1;
      }
      return count;
    };

    for (const key of quotas.order) {
      takeFromBucket(byDifficulty[key], quotas.counts[key]);
    }

    if (chosenIds.length < uniquePerSet) {
      const fallbackRanked = [...candidates].sort((a, b) => {
        const aDifficulty = this.normalizeDifficulty(a.difficulty);
        const bDifficulty = this.normalizeDifficulty(b.difficulty);
        const aDifficultyScore = aDifficulty ? quotas.preference[aDifficulty] : 0;
        const bDifficultyScore = bDifficulty ? quotas.preference[bDifficulty] : 0;
        if (aDifficultyScore !== bDifficultyScore) return bDifficultyScore - aDifficultyScore;
        return sortByLevelThenIndex(a, b);
      });
      for (const c of fallbackRanked) {
        if (chosenIds.length >= uniquePerSet) break;
        if (chosenSet.has(c.id)) continue;
        chosenSet.add(c.id);
        chosenIds.push(c.id);
      }
    }

    return chosenIds;
  }

  private getDifficultyQuotasForSet(setLevelCode: string, uniquePerSet: number) {
    const profiles: Record<
      string,
      { hard: number; medium: number; easy: number; order: Array<'easy' | 'medium' | 'hard'> }
    > = {
      'A+': { hard: 0.75, medium: 0.2, easy: 0.05, order: ['hard', 'medium', 'easy'] },
      A: { hard: 0.55, medium: 0.3, easy: 0.15, order: ['hard', 'medium', 'easy'] },
      B: { hard: 0.3, medium: 0.5, easy: 0.2, order: ['medium', 'hard', 'easy'] },
      C: { hard: 0.15, medium: 0.45, easy: 0.4, order: ['medium', 'easy', 'hard'] },
      D: { hard: 0.05, medium: 0.3, easy: 0.65, order: ['easy', 'medium', 'hard'] },
      E: { hard: 0, medium: 0.2, easy: 0.8, order: ['easy', 'medium', 'hard'] },
    };
    const profile = profiles[setLevelCode] ?? profiles.D;

    const raw = {
      hard: profile.hard * uniquePerSet,
      medium: profile.medium * uniquePerSet,
      easy: profile.easy * uniquePerSet,
    };
    const counts = {
      hard: Math.floor(raw.hard),
      medium: Math.floor(raw.medium),
      easy: Math.floor(raw.easy),
    };
    let assigned = counts.hard + counts.medium + counts.easy;
    const remainders = (['hard', 'medium', 'easy'] as const)
      .map((k) => ({ key: k, remainder: raw[k] - Math.floor(raw[k]) }))
      .sort((a, b) => b.remainder - a.remainder);
    let idx = 0;
    while (assigned < uniquePerSet) {
      const key = remainders[idx % remainders.length].key;
      counts[key] += 1;
      assigned += 1;
      idx += 1;
    }

    const preference = {
      hard: profile.order[0] === 'hard' ? 3 : profile.order[1] === 'hard' ? 2 : 1,
      medium: profile.order[0] === 'medium' ? 3 : profile.order[1] === 'medium' ? 2 : 1,
      easy: profile.order[0] === 'easy' ? 3 : profile.order[1] === 'easy' ? 2 : 1,
    } as Record<'easy' | 'medium' | 'hard', number>;

    return { counts, order: profile.order, preference };
  }

  private normalizeDifficulty(value: string | null): 'easy' | 'medium' | 'hard' | null {
    const v = (value ?? '').trim().toLowerCase();
    if (v === 'easy' || v === 'medium' || v === 'hard') return v;
    return null;
  }
}
