import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateTopicDto } from './dto/create-topic.dto';
import { UpdateTopicDto } from './dto/update-topic.dto';
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
    return created;
  }

  async findAll(orgId: string) {
    const scopedOrgId = this.requireOrgId(orgId);
    return this.db
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
    return row;
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
    return updated;
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
}
