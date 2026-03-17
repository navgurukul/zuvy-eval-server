import { BadRequestException, Injectable, NotFoundException, Inject } from '@nestjs/common';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, sql } from 'drizzle-orm';
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
        domainName: dto.domainName,
        topicName: dto.topicName,
        topicDescription: dto.topicDescription,
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
    domainName?: string;
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

    const domainName = params?.domainName?.trim();
    const difficulty = params?.difficulty?.trim();
    const topicName = params?.topicName?.trim();

    const conditions = [
      eq(zuvyQuestions.orgId, orgId),
      domainName ? eq(zuvyQuestions.domainName, domainName) : undefined,
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
      'domainName',
      'topicName',
      'topicDescription',
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
}

