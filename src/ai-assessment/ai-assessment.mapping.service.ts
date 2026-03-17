import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from 'src/db/constant';
import { aiAssessment } from 'src/db/schema/ai-assessment';
import { aiAssessmentQuestionSets } from './ai-assessment.question-set.schema';
import { aiAssessmentQuestions } from './ai-assessment.questions.schema';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { VectorService } from 'src/vector/vector.service';

@Injectable()
export class AiAssessmentMappingService {
  private readonly logger = new Logger(AiAssessmentMappingService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    private readonly embeddingsService: EmbeddingsService,
    private readonly vectorService: VectorService,
  ) {}

  /**
   * Map (generate) questions for an assessment into sets + questions table.
   * - Baseline assessment (first for bootcamp): 1 set.
   * - Subsequent assessments: 6 sets (E, D, C, B, A, A+).
   * Uses Qdrant vector search over zuvy_questions embeddings based on assessment metadata.
   */
  async mapQuestionsForAssessment(aiAssessmentId: number) {
    return this.db.transaction(async (tx) => {
      // 1) Load assessment
      const [assessment] = await tx
        .select()
        .from(aiAssessment)
        .where(eq(aiAssessment.id, aiAssessmentId))
        .limit(1);

      if (!assessment) {
        throw new NotFoundException(
          `AI assessment with id=${aiAssessmentId} not found`,
        );
      }

      const totalQuestions: number = assessment.totalNumberOfQuestions;
      if (!totalQuestions || totalQuestions <= 0) {
        throw new BadRequestException(
          'totalNumberOfQuestions must be > 0 to map questions',
        );
      }

      // 2) Clear existing sets/questions for idempotent re-generation
      const existingSets = await tx
        .select({ id: aiAssessmentQuestionSets.id })
        .from(aiAssessmentQuestionSets)
        .where(eq(aiAssessmentQuestionSets.aiAssessmentId, aiAssessmentId));

      if (existingSets.length > 0) {
        const setIds = existingSets.map((s) => s.id);
        await tx
          .delete(aiAssessmentQuestions)
          .where(inArray(aiAssessmentQuestions.questionSetId, setIds as number[]));
        await tx
          .delete(aiAssessmentQuestionSets)
          .where(eq(aiAssessmentQuestionSets.aiAssessmentId, aiAssessmentId));
      }

      // 3) Determine if this is baseline: first assessment for this bootcamp
      const [firstForBootcamp] = await tx
        .select({ id: aiAssessment.id })
        .from(aiAssessment)
        .where(eq(aiAssessment.bootcampId, assessment.bootcampId))
        .orderBy(aiAssessment.id)
        .limit(1);

      const isBaseline = firstForBootcamp?.id === assessment.id;

      // 4) Build semantic query from assessment metadata
      const topicsText =
        (assessment.topics as any)?.map?.((t: any) => t?.name || t)?.join(' ') ??
        '';
      const audienceText =
        typeof assessment.audience === 'string'
          ? assessment.audience
          : JSON.stringify(assessment.audience ?? '');

      const queryText = [
        assessment.title ?? '',
        assessment.description ?? '',
        topicsText,
        audienceText,
      ]
        .filter(Boolean)
        .join(' ');

      const queryVector = await this.embeddingsService.embed(queryText);

      // We over-query a bit to have a pool to draw common + unique questions from.
      const QDRANT_QUESTIONS_COLLECTION = 'QUESTIONS';
      const safetyFactor = 2;
      const commonPerSet = Math.round(totalQuestions * 0.4);
      const uniquePerSet = totalQuestions - commonPerSet;
      // Baseline: we only need totalQuestions. Non-baseline: 40 common + 60*6 unique = 400 distinct for totalQuestions=100.
      const distinctNeededNonBaseline = commonPerSet + uniquePerSet * 6;
      const neededTotal = isBaseline
        ? totalQuestions
        : distinctNeededNonBaseline * safetyFactor;

      const vectorResults = await this.vectorService.search({
        collectionName: QDRANT_QUESTIONS_COLLECTION,
        queryVector,
        limit: neededTotal,
        filter: undefined,
      });

      const allQuestionIdsFromVector = vectorResults
        .map((r) => Number(r.payload?.questionId ?? r.id))
        .filter((id) => Number.isFinite(id)) as number[];

      if (allQuestionIdsFromVector.length === 0) {
        this.logger.warn(
          `No vector search results for assessment id=${aiAssessmentId}; no questions will be mapped`,
        );
        return {
          aiAssessmentId,
          isBaseline,
          setsCreated: 0,
          totalQuestionsPerSet: totalQuestions,
        };
      }

      // 5) Baseline: single set with top-N relevant questions
      if (isBaseline) {
        const [insertedSet] = await tx
          .insert(aiAssessmentQuestionSets)
          .values({
            aiAssessmentId,
            setIndex: 1,
            label: 'BASELINE',
            levelCode: null,
          } as any)
          .returning({ id: aiAssessmentQuestionSets.id });

        const baselineIds = allQuestionIdsFromVector.slice(0, totalQuestions);

        // Ensure they still exist in Postgres
        const baselineQuestions = await tx
          .select({ id: zuvyQuestions.id })
          .from(zuvyQuestions)
          .where(inArray(zuvyQuestions.id, baselineIds));

        const idSet = new Set(baselineQuestions.map((q) => q.id));
        const finalIdsInOrder = baselineIds.filter((id) => idSet.has(id));

        const rows = finalIdsInOrder.map((id, idx) => ({
          questionSetId: insertedSet.id,
          questionId: id,
          isCommon: false,
          position: idx + 1,
        }));

        if (rows.length > 0) {
          await tx.insert(aiAssessmentQuestions).values(rows as any);
        }

        return {
          aiAssessmentId,
          isBaseline: true,
          setsCreated: 1,
          totalQuestionsPerSet: totalQuestions,
        };
      }

      // --- Non-baseline: 6 sets E, D, C, B, A, A+ ---
      const setDefinitions: {
        setIndex: number;
        label: string;
        levelCode: string;
        questionLevelId: string;
      }[] = [
        { setIndex: 1, label: 'SET_E', levelCode: 'E', questionLevelId: 'E' },
        { setIndex: 2, label: 'SET_D', levelCode: 'D', questionLevelId: 'D' },
        { setIndex: 3, label: 'SET_C', levelCode: 'C', questionLevelId: 'C' },
        { setIndex: 4, label: 'SET_B', levelCode: 'B', questionLevelId: 'B' },
        {
          setIndex: 5,
          label: 'SET_A',
          levelCode: 'A',
          questionLevelId: 'A',
        },
        {
          setIndex: 6,
          label: 'SET_A_PLUS',
          levelCode: 'A+',
          // A+ students use the hardest band, which we store as 'A' on questions.
          questionLevelId: 'A',
        },
      ];

      // 6) Create sets
      const insertedSets = await tx
        .insert(aiAssessmentQuestionSets)
        .values(
          setDefinitions.map((s) => ({
            aiAssessmentId,
            setIndex: s.setIndex,
            label: s.label,
            levelCode: s.levelCode,
          })) as any,
        )
        .returning({
          id: aiAssessmentQuestionSets.id,
          setIndex: aiAssessmentQuestionSets.setIndex,
        });

      const setIdByIndex = new Map<number, number>();
      insertedSets.forEach((s) => setIdByIndex.set(s.setIndex, s.id));

      // 7) Load all candidate questions from DB to know their levelId
      const candidates = await tx
        .select({
          id: zuvyQuestions.id,
          levelId: zuvyQuestions.levelId,
        })
        .from(zuvyQuestions)
        .where(inArray(zuvyQuestions.id, allQuestionIdsFromVector));

      const byId = new Map<number, { id: number; levelId: string | null }>();
      candidates.forEach((c) =>
        byId.set(c.id, { id: c.id, levelId: (c.levelId as any) ?? null }),
      );

      const orderedCandidateIds = allQuestionIdsFromVector.filter((id) =>
        byId.has(id),
      );

      // 8) Choose common pool (agnostic of level but from top of relevance list)
      const commonIds = orderedCandidateIds.slice(0, commonPerSet);
      const remainingIds = orderedCandidateIds.slice(commonPerSet);

      // 9) Insert common questions into each set
      const commonRows: any[] = [];
      for (const def of setDefinitions) {
        const setId = setIdByIndex.get(def.setIndex)!;
        commonIds.forEach((id, idx) => {
          commonRows.push({
            questionSetId: setId,
            questionId: id,
            isCommon: true,
            position: idx + 1,
          });
        });
      }
      if (commonRows.length > 0) {
        await tx.insert(aiAssessmentQuestions).values(commonRows);
      }

      // 10) Unique questions per set, preferring exact level matches, then relaxing
      for (const def of setDefinitions) {
        const setId = setIdByIndex.get(def.setIndex)!;
        const preferredLevel = def.questionLevelId;

        const exactMatches = remainingIds.filter(
          (id) => byId.get(id)?.levelId === preferredLevel,
        );
        let chosen = exactMatches.slice(0, uniquePerSet);

        if (chosen.length < uniquePerSet) {
          // Relax: allow any remaining ids regardless of level, while avoiding duplicates within this set.
          const needed = uniquePerSet - chosen.length;
          const fallback = remainingIds.filter((id) => !chosen.includes(id));
          chosen = chosen.concat(fallback.slice(0, needed));
          if (chosen.length < uniquePerSet) {
            this.logger.warn(
              `Not enough unique questions for setIndex=${def.setIndex} level=${def.levelCode} (assessment id=${aiAssessmentId}); requested=${uniquePerSet}, got=${chosen.length}`,
            );
          }
        }

        const uniqueRows = chosen.map((id, idx) => ({
          questionSetId: setId,
          questionId: id,
          isCommon: false,
          position: commonPerSet + idx + 1,
        }));

        if (uniqueRows.length > 0) {
          await tx.insert(aiAssessmentQuestions).values(uniqueRows as any);
        }
      }

      return {
        aiAssessmentId,
        isBaseline: false,
        setsCreated: setDefinitions.length,
        totalQuestionsPerSet: totalQuestions,
        commonPerSet,
        uniquePerSet,
      };
    });
  }
}

