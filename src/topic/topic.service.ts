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
import { topic, zuvyCourseModules } from './db/topic.schema';
import { and, eq } from 'drizzle-orm';
import { zuvyBootcamps } from 'src/db/schema/parentSchema';

@Injectable()
export class TopicService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase) {}

  async create(createTopicDto: CreateTopicDto) {
    const [created] = await this.db
      .insert(topic)
      .values({
        name: createTopicDto.name,
        description: createTopicDto.description ?? null,
        subtopic: createTopicDto.subtopic ?? null,
      })
      .returning();
    return created;
  }

  async findAll() {
    return this.db
      .select({
        id: topic.id,
        name: topic.name,
        description: topic.description,
        subtopic: topic.subtopic,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      })
      .from(topic);
  }

  async findOne(id: number) {
    const [row] = await this.db
      .select({
        id: topic.id,
        name: topic.name,
        description: topic.description,
        subtopic: topic.subtopic,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      })
      .from(topic)
      .where(eq(topic.id, id))
      .limit(1);
    if (!row) throw new NotFoundException(`Topic with id=${id} not found`);
    return row;
  }

  async update(id: number, updateTopicDto: UpdateTopicDto) {
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
      .where(eq(topic.id, id))
      .returning();
    if (!updated) throw new NotFoundException(`Topic with id=${id} not found`);
    return updated;
  }

  async remove(id: number) {
    const [deleted] = await this.db
      .delete(topic)
      .where(eq(topic.id, id))
      .returning({ id: topic.id });
    if (!deleted) throw new NotFoundException(`Topic with id=${id} not found`);
    return { id: deleted.id, deleted: true };
  }
}
