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
import { and, eq } from 'drizzle-orm';

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
}
