import { BadRequestException, Injectable, NotFoundException, Inject } from '@nestjs/common';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, ne, notInArray, sql } from 'drizzle-orm';
import { aiAssessmentQuestions } from 'src/ai-assessment/ai-assessment.questions.schema';
import { zuvyQuestions } from './schema/zuvy-questions.schema';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';

@Injectable()
export class QuestionsCrudService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase) {}

  async create(orgId: string, dto: CreateQuestionDto) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId is required');
    }

    const [row] = await this.db
      .insert(zuvyQuestions)
      .values({
        orgId: orgId.trim(),
        domainName: null,
        topicName: dto.topicName,
        topicDescription: dto.topicDescription,
        subtopics: dto.subtopics ?? null,
        learningObjectives: dto.learningObjectives ?? null,
        targetAudience: dto.targetAudience ?? null,
        focusAreas: dto.focusAreas ?? null,
        bloomsLevel: dto.bloomsLevel ?? null,
        questionStyle: dto.questionStyle ?? null,
        question: dto.question,
        difficulty: dto.difficulty ?? null,
        language: dto.language ?? null,
        options: dto.options,
        correctOption: dto.correctOption,
        difficultyDistribution: dto.difficultyDistribution ?? null,
        questionCounts: dto.questionCounts ?? null,
        levelId: dto.levelId ?? null,
      })
      .returning();

    return row;
  }

  async findAll(params: {
    orgId: string;
    page?: number | string;
    limit?: number | string;
    difficulty?: string;
    topicName?: string;
  }): Promise<{
    data: unknown[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    const pageRaw = params?.page ?? 1;
    const limitRaw = params?.limit ?? 20;

    const page =
      typeof pageRaw === 'string' ? Number.parseInt(pageRaw, 10) : pageRaw;
    const limit =
      typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : limitRaw;

    if (!Number.isFinite(page) || page < 1) {
      throw new BadRequestException('page must be a positive integer');
    }
    if (!Number.isFinite(limit) || limit < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }

    const safeLimit = Math.min(100, Math.floor(limit));
    const safePage = Math.floor(page);
    const offset = (safePage - 1) * safeLimit;

    const orgId = params?.orgId?.trim();
    if (!orgId) {
      throw new BadRequestException('orgId is required');
    }

    const difficulty = params?.difficulty?.trim();
    const topicName = params?.topicName?.trim();

    const conditions = [
      eq(zuvyQuestions.orgId, orgId),
      difficulty ? eq(zuvyQuestions.difficulty, difficulty) : undefined,
      topicName ? eq(zuvyQuestions.topicName, topicName) : undefined,
    ].filter(Boolean);

    const whereClause = and(...(conditions as any));

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(zuvyQuestions)
      .where(whereClause as any);

    const total = Number(count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / safeLimit));

    const data = await this.db
      .select()
      .from(zuvyQuestions)
      .where(whereClause as any)
      .orderBy(desc(zuvyQuestions.createdAt))
      .limit(safeLimit)
      .offset(offset);

    return {
      data,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages,
    };
  }

  async findOne(orgId: string, id: number) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId is required');
    }
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('id must be a positive integer');
    }

    const rows = await this.db
      .select()
      .from(zuvyQuestions)
      .where(and(eq(zuvyQuestions.id, id), eq(zuvyQuestions.orgId, orgId.trim())))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('Question not found');
    }

    return rows[0];
  }

  async update(orgId: string, id: number, dto: UpdateQuestionDto) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId is required');
    }
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('id must be a positive integer');
    }

    const patch: Record<string, unknown> = {};
    const updatable: (keyof UpdateQuestionDto)[] = [
      'topicName',
      'topicDescription',
      'subtopics',
      'question',
      'difficulty',
      'language',
      'options',
      'correctOption',
      'learningObjectives',
      'targetAudience',
      'focusAreas',
      'bloomsLevel',
      'questionStyle',
      'difficultyDistribution',
      'questionCounts',
      'levelId',
    ];

    for (const key of updatable) {
      const v = dto[key];
      if (v !== undefined) patch[key] = v;
    }

    patch.updatedAt = sql`now()`;

    const [row] = await this.db
      .update(zuvyQuestions)
      .set(patch as any)
      .where(and(eq(zuvyQuestions.id, id), eq(zuvyQuestions.orgId, orgId.trim())))
      .returning();

    if (!row) {
      throw new NotFoundException('Question not found');
    }

    return row;
  }

  async remove(orgId: string, id: number) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId is required');
    }
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('id must be a positive integer');
    }

    const [row] = await this.db
      .delete(zuvyQuestions)
      .where(and(eq(zuvyQuestions.id, id), eq(zuvyQuestions.orgId, orgId.trim())))
      .returning({ id: zuvyQuestions.id });

    if (!row) {
      throw new NotFoundException('Question not found');
    }

    return row;
  }


  async findReplacements(params: {
    orgId: string;
    topicName: string;
    difficulty: string;
    questionSetId: number;
    excludeId?: number;
  }): Promise<{ data: unknown[]; total: number; message?: string }> {
    const orgId = params.orgId?.trim();
    if (!orgId) {
      throw new BadRequestException('orgId is required');
    }

    const topicName = params.topicName?.trim();
    if (!topicName) {
      throw new BadRequestException('topicName is required');
    }

    const difficulty = params.difficulty?.trim();
    if (!difficulty) {
      throw new BadRequestException('difficulty is required');
    }
    if (!Number.isInteger(params.questionSetId) || params.questionSetId <= 0) {
      throw new BadRequestException('questionSetId must be a positive integer');
    }

    const existingSetQuestions = await this.db
      .select({ questionId: aiAssessmentQuestions.questionId })
      .from(aiAssessmentQuestions)
      .where(eq(aiAssessmentQuestions.questionSetId, params.questionSetId));

    const conditions: any[] = [
      eq(zuvyQuestions.orgId, orgId),
      sql`LOWER(${zuvyQuestions.topicName}) = LOWER(${topicName})`,
      sql`LOWER(${zuvyQuestions.difficulty}) = LOWER(${difficulty})`,
    ];

    if (params.excludeId && Number.isInteger(params.excludeId) && params.excludeId > 0) {
      conditions.push(ne(zuvyQuestions.id, params.excludeId));
    }

    const existingQuestionIds = existingSetQuestions.map(({ questionId }) => questionId);
    if (existingQuestionIds.length > 0) {
      conditions.push(notInArray(zuvyQuestions.id, existingQuestionIds));
    }

    const whereClause = and(...conditions);

    const data = await this.db
      .select({
        id: zuvyQuestions.id,
        topicName: zuvyQuestions.topicName,
        difficulty: zuvyQuestions.difficulty,
        question: zuvyQuestions.question,
        options: zuvyQuestions.options,
        correctOption: zuvyQuestions.correctOption,
        levelId: zuvyQuestions.levelId,
      })
      .from(zuvyQuestions)
      .where(whereClause as any)
      .orderBy(desc(zuvyQuestions.createdAt));

    return {
      data,
      total: data.length,
      message:
        data.length === 0
          ? 'No replacement questions are available for this topic and difficulty.'
          : undefined,
    };
  }

  async replaceInQuestionSet(oldQuestionId: number, questionSetId: number, newQuestionId: number) {
    if (!Number.isInteger(oldQuestionId) || oldQuestionId <= 0) {
      throw new BadRequestException('oldQuestionId must be a positive integer');
    }
    if (!Number.isInteger(newQuestionId) || newQuestionId <= 0) {
      throw new BadRequestException('replacementQuestionId must be a positive integer');
    }
    if (!Number.isInteger(questionSetId) || questionSetId <= 0) {
      throw new BadRequestException('questionSetId must be a positive integer');
    }

    // Ensure replacement isn't already present in the set (unique constraint)
    const existing = await this.db
      .select()
      .from(aiAssessmentQuestions)
      .where(and(eq(aiAssessmentQuestions.questionSetId, questionSetId), eq(aiAssessmentQuestions.questionId, newQuestionId)))
      .limit(1);

    if (existing.length > 0) {
      throw new BadRequestException('Replacement question already exists in the set');
    }

    const [[replacedQuestion], [replacementQuestion]] = await Promise.all([
      this.db
        .select({ id: zuvyQuestions.id, question: zuvyQuestions.question })
        .from(zuvyQuestions)
        .where(eq(zuvyQuestions.id, oldQuestionId))
        .limit(1),
      this.db
        .select({ id: zuvyQuestions.id, question: zuvyQuestions.question })
        .from(zuvyQuestions)
        .where(eq(zuvyQuestions.id, newQuestionId))
        .limit(1),
    ]);

    const [row] = await this.db
      .update(aiAssessmentQuestions)
      .set({ questionId: newQuestionId, updatedAt: sql`now()` } as any)
      .where(and(eq(aiAssessmentQuestions.questionSetId, questionSetId), eq(aiAssessmentQuestions.questionId, oldQuestionId)))
      .returning();

    if (!row) {
      throw new NotFoundException('Question not found in the requested set');
    }

    return {
      ...row,
      replacedQuestionId: oldQuestionId,
      replacementQuestionId: newQuestionId,
      replacedQuestion,
      replacementQuestion,
    };
  }
}
