import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateTopicDto } from './dto/create-topic.dto';
import { UpdateTopicDto } from './dto/update-topic.dto';
import { AddSubtopicDto } from './dto/add-subtopic.dto';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { topic } from './db/topic.schema';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';
import { and, eq, sql } from 'drizzle-orm';

@Injectable()
export class TopicService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase) {}

  async create(orgId: string, createTopicDto: CreateTopicDto) {
    const scopedOrgId = this.requireOrgId(orgId);
    const [created] = await this.db
      .insert(topic)
      .values({
        orgId: scopedOrgId,
        name: createTopicDto.name,
        description: createTopicDto.description ?? null,
        subtopic: createTopicDto.subtopic ?? null,
      })
      .returning();
    return this.withNormalizedSubtopics(created);
  }

  async findAll(orgId: string) {
    const scopedOrgId = this.requireOrgId(orgId);
    const topics = await this.db
      .select({
        id: topic.id,
        orgId: topic.orgId,
        name: topic.name,
        description: topic.description,
        subtopic: topic.subtopic,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      })
      .from(topic)
      .where(eq(topic.orgId, scopedOrgId));
    return topics.map((row) => this.withNormalizedSubtopics(row));
  }

  async findOne(orgId: string, id: number) {
    const scopedOrgId = this.requireOrgId(orgId);
    const [row] = await this.db
      .select({
        id: topic.id,
        orgId: topic.orgId,
        name: topic.name,
        description: topic.description,
        subtopic: topic.subtopic,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      })
      .from(topic)
      .where(and(eq(topic.id, id), eq(topic.orgId, scopedOrgId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Topic with id=${id} not found`);
    return this.withNormalizedSubtopics(row);
  }

  async update(orgId: string, id: number, updateTopicDto: UpdateTopicDto) {
    const scopedOrgId = this.requireOrgId(orgId);
    const [updated] = await this.db
      .update(topic)
      .set({
        ...(updateTopicDto.name !== undefined ? { name: updateTopicDto.name } : {}),
        ...(updateTopicDto.description !== undefined
          ? { description: updateTopicDto.description }
          : {}),
        ...(updateTopicDto.subtopic !== undefined
          ? { subtopic: updateTopicDto.subtopic }
          : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(topic.id, id), eq(topic.orgId, scopedOrgId)))
      .returning();
    if (!updated) throw new NotFoundException(`Topic with id=${id} not found`);
    return this.withNormalizedSubtopics(updated);
  }

  async addSubtopic(orgId: string, id: number, addSubtopicDto: AddSubtopicDto) {
    const scopedOrgId = this.requireOrgId(orgId);
    const name = addSubtopicDto.subtopic.trim();
    if (!name) {
      throw new BadRequestException('Subtopic name cannot be empty');
    }

    const existingTopic = await this.findOne(scopedOrgId, id);
    const existingSubtopics = this.normalizeSubtopics(existingTopic.subtopic);
    const duplicate = existingSubtopics.some(
      (subtopicName) => subtopicName.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (duplicate) {
      throw new BadRequestException(`Subtopic \"${name}\" already exists`);
    }

    const [updated] = await this.db
      .update(topic)
      .set({
        subtopic: [...existingSubtopics, name],
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(topic.id, id), eq(topic.orgId, scopedOrgId)))
      .returning();
    if (!updated) throw new NotFoundException(`Topic with id=${id} not found`);
    return this.withNormalizedSubtopics(updated);
  }

  async remove(orgId: string, id: number) {
    const scopedOrgId = this.requireOrgId(orgId);
    const [deleted] = await this.db
      .delete(topic)
      .where(and(eq(topic.id, id), eq(topic.orgId, scopedOrgId)))
      .returning({ id: topic.id });
    if (!deleted) throw new NotFoundException(`Topic with id=${id} not found`);
    return { id: deleted.id, deleted: true };
  }

  private requireOrgId(orgId: string): string {
    const scopedOrgId = orgId?.trim();
    if (!scopedOrgId) {
      throw new BadRequestException('orgId is required');
    }
    return scopedOrgId;
  }

  private normalizeSubtopics(value: unknown): string[] {
    if (!value) return [];

    // Accept arrays too, so older/newer clients can safely migrate to a
    // simple list of names without losing their existing concepts.
    if (Array.isArray(value)) {
      return value.reduce<string[]>((subtopics, subtopic) => {
        if (typeof subtopic === 'string' && subtopic.trim()) {
          subtopics.push(subtopic.trim());
        }
        return subtopics;
      }, []);
    }

    if (typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).reduce<string[]>(
        (subtopics, name) => {
          if (name.trim()) {
            subtopics.push(name.trim());
          }
          return subtopics;
        },
        [],
      );
    }

    return [];
  }

  private withNormalizedSubtopics<T extends { subtopic: unknown }>(row: T) {
    return { ...row, subtopic: this.normalizeSubtopics(row.subtopic) };
  }

  async resolveTagsFromChapterIds(
    orgId: string,
    body: { chapterIds: number[]; bootcampId?: number; moduleId: number },
    authorization?: string,
  ) {
    this.requireOrgId(orgId);
    const { chapterIds, bootcampId, moduleId } = body;
    if (!Array.isArray(chapterIds) || chapterIds.length === 0) {
      throw new BadRequestException('chapterIds must be a non-empty array');
    }

    const ZUVY_BASE = process.env.ZUVY_LEGACY_BASE_URL
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authorization) headers['Authorization'] = authorization;

    // Step 1: Resolve topicId for each chapterId via allChaptersOfModule
    const allChaptersRaw = await fetch(`${ZUVY_BASE}/Content/allChaptersOfModule/${moduleId}`, { headers })
      .then((res) => res.json() as Promise<{ chapterWithTopic?: Array<{ chapterId: number; topicId: number }> }>)
      .catch(() => ({ chapterWithTopic: [] }));

    const chapterTopicMap = new Map<number, number>();
    for (const entry of allChaptersRaw?.chapterWithTopic ?? []) {
      chapterTopicMap.set(entry.chapterId, entry.topicId);
    }

    // Step 2: Fetch chapter details in parallel using the resolved topicId per chapter
    const chapterDetailsResponses = await Promise.all(
      chapterIds.map((chapterId) => {
        const topicId = chapterTopicMap.get(chapterId);
        const params = new URLSearchParams();
        if (bootcampId != null) params.set('bootcampId', String(bootcampId));
        params.set('moduleId', String(moduleId));
        if (topicId != null) params.set('topicId', String(topicId));
        const qs = params.toString() ? '?' + params.toString() : '';
        return fetch(`${ZUVY_BASE}/Content/chapterDetailsById/${chapterId}${qs}`, { headers })
          .then((res) => res.json() as Promise<Record<string, unknown>>)
          .catch(() => ({} as Record<string, unknown>));
      }),
    );

    // Step 3: Collect tagIds from quizQuestionDetails[].tagId
    const tagIdSet = new Set<number>();
    for (const detail of chapterDetailsResponses) {
      if (detail?.statusCode && Number(detail.statusCode) >= 400) continue;
      const quizDetails = Array.isArray(detail?.quizQuestionDetails)
        ? (detail.quizQuestionDetails as { tagId?: number }[])
        : [];
      for (const q of quizDetails) {
        if (typeof q.tagId === 'number') tagIdSet.add(q.tagId);
      }
    }

    if (tagIdSet.size === 0) return [];

    // Step 4: Fetch all tags and return only those matching the collected tagIds
    const allTagsRaw = await fetch(`${ZUVY_BASE}/Content/allTags`, { headers })
      .then((res) => res.json() as Promise<{ allTags?: Array<{ id: number; tagName?: string }> }>);
    const allTags = Array.isArray(allTagsRaw?.allTags) ? allTagsRaw.allTags : [];

    return allTags
      .filter((t) => tagIdSet.has(t.id))
      .map((t) => ({ tagId: t.id, topicName: t.tagName }));
  }

   async getAllTopicsWithDifficultyLevels(orgId: string, search?: string) {
    const scopedOrgId = this.requireOrgId(orgId);
    const conditions: any[] = [eq(topic.orgId, scopedOrgId)];
    if (search && search.trim()) {
      const pattern = `%${search.trim().toLowerCase()}%`;
      conditions.push(sql`LOWER(${topic.name}) LIKE ${pattern}`);
    }

    const topicQuestions = await this.db
      .select({
        id: topic.id,
        name: topic.name,
        difficulty: zuvyQuestions.difficulty,
      })
      .from(topic)
      .leftJoin(zuvyQuestions, eq(topic.name, zuvyQuestions.topicName))
      .where(and(...conditions));

    const topicsById = new Map<
      number,
      {
        name: string;
        difficultyLevel: { easy: number; medium: number; hard: number };
      }
    >();

    for (const { id, name, difficulty } of topicQuestions) {
      const topicWithDifficulty = topicsById.get(id) ?? {
        name,
        difficultyLevel: { easy: 0, medium: 0, hard: 0 },
      };
      const normalizedDifficulty = difficulty?.trim().toLowerCase();

      if (normalizedDifficulty === 'easy') topicWithDifficulty.difficultyLevel.easy += 1;
      if (normalizedDifficulty === 'medium') topicWithDifficulty.difficultyLevel.medium += 1;
      if (normalizedDifficulty === 'hard') topicWithDifficulty.difficultyLevel.hard += 1;

      topicsById.set(id, topicWithDifficulty);
    }

    return [...topicsById.values()];
  }
}