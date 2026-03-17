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
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
  ) {}

  private validateBootcampId(bootcampId: string) {
    if (!bootcampId?.trim()) {
      throw new BadRequestException('Valid bootcampId query param is required');
    }
  }

  private normalizeOrgId(orgId: string | number) {
    const parsed = Number(orgId);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException('Valid orgId is required in token');
    }
    return parsed;
  }

  private async ensureModuleInBootcamp(
    moduleId: number,
    bootcampId: string,
    orgId: string | number,
  ) {
    const normalizedOrgId = this.normalizeOrgId(orgId);
    const [moduleRow] = await this.db
      .select({ id: zuvyCourseModules.id })
      .from(zuvyCourseModules)
      .innerJoin(zuvyBootcamps, eq(zuvyBootcamps.id, zuvyCourseModules.bootcampId))
      .where(
        and(
          eq(zuvyCourseModules.id, moduleId),
          eq(zuvyCourseModules.bootcampId, bootcampId),
          eq(zuvyBootcamps.organizationId, normalizedOrgId),
        ),
      )
      .limit(1);

    if (!moduleRow) {
      throw new BadRequestException(
        `moduleId=${moduleId} does not belong to bootcampId=${bootcampId}`,
      );
    }
  }

  async create(
    bootcampId: string,
    orgId: string | number,
    createTopicDto: CreateTopicDto,
  ) {
    this.validateBootcampId(bootcampId);
    await this.ensureModuleInBootcamp(createTopicDto.moduleId, bootcampId, orgId);

    const [created] = await this.db
      .insert(topic)
      .values({
        moduleId: createTopicDto.moduleId,
        name: createTopicDto.name,
        description: createTopicDto.description ?? null,
      } as any)
      .returning();

    return created;
  }

  async findAll(bootcampId: string, orgId: string | number) {
    this.validateBootcampId(bootcampId);
    const normalizedOrgId = this.normalizeOrgId(orgId);

    return this.db
      .select({
        id: topic.id,
        moduleId: topic.moduleId,
        name: topic.name,
        description: topic.description,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      })
      .from(topic)
      .innerJoin(zuvyCourseModules, eq(topic.moduleId, zuvyCourseModules.id))
      .innerJoin(zuvyBootcamps, eq(zuvyBootcamps.id, zuvyCourseModules.bootcampId))
      .where(
        and(
          eq(zuvyCourseModules.bootcampId, bootcampId),
          eq(zuvyBootcamps.organizationId, normalizedOrgId),
        ),
      );
  }

  async findOne(bootcampId: string, orgId: string | number, id: number) {
    this.validateBootcampId(bootcampId);
    const normalizedOrgId = this.normalizeOrgId(orgId);

    const [row] = await this.db
      .select({
        id: topic.id,
        moduleId: topic.moduleId,
        name: topic.name,
        description: topic.description,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      })
      .from(topic)
      .innerJoin(zuvyCourseModules, eq(topic.moduleId, zuvyCourseModules.id))
      .innerJoin(zuvyBootcamps, eq(zuvyBootcamps.id, zuvyCourseModules.bootcampId))
      .where(
        and(
          eq(topic.id, id),
          eq(zuvyCourseModules.bootcampId, bootcampId),
          eq(zuvyBootcamps.organizationId, normalizedOrgId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundException(
        `Topic with id=${id} not found for bootcampId=${bootcampId}`,
      );
    }

    return row;
  }

  async update(
    bootcampId: string,
    orgId: string | number,
    id: number,
    updateTopicDto: UpdateTopicDto,
  ) {
    this.validateBootcampId(bootcampId);
    await this.findOne(bootcampId, orgId, id);

    if (updateTopicDto.moduleId !== undefined) {
      await this.ensureModuleInBootcamp(updateTopicDto.moduleId, bootcampId, orgId);
    }

    const [updated] = await this.db
      .update(topic)
      .set({
        ...(updateTopicDto.moduleId !== undefined
          ? { moduleId: updateTopicDto.moduleId }
          : {}),
        ...(updateTopicDto.name !== undefined ? { name: updateTopicDto.name } : {}),
        ...(updateTopicDto.description !== undefined
          ? { description: updateTopicDto.description }
          : {}),
        updatedAt: new Date().toISOString(),
      } as any)
      .where(eq(topic.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundException(
        `Topic with id=${id} not found for bootcampId=${bootcampId}`,
      );
    }

    return updated;
  }

  async remove(bootcampId: string, orgId: string | number, id: number) {
    this.validateBootcampId(bootcampId);
    await this.findOne(bootcampId, orgId, id);

    const [deleted] = await this.db
      .delete(topic)
      .where(eq(topic.id, id))
      .returning({ id: topic.id });

    if (!deleted) {
      throw new NotFoundException(
        `Topic with id=${id} not found for bootcampId=${bootcampId}`,
      );
    }

    return { id: deleted.id, deleted: true };
  }

  async findByModule(
    bootcampId: string,
    orgId: string | number,
    moduleId: number,
  ) {
    this.validateBootcampId(bootcampId);
    await this.ensureModuleInBootcamp(moduleId, bootcampId, orgId);

    return this.db
      .select({
        id: topic.id,
        name: topic.name,
        description: topic.description,
      })
      .from(topic)
      .where(eq(topic.moduleId, moduleId));
  }
}
