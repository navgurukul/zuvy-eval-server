import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Inject } from '@nestjs/common';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import {
  GenerateQuestionsDto,
  GenerateTopicBatchJobPayload,
} from './dto/generate-questions.dto';
import { questionIndexOutbox, zuvyQuestions } from './schema/zuvy-questions.schema';

const BATCH_SIZE = 10;
const JOB_NAME = 'generate-topic-batch';

const JOB_OPTS = {
  attempts: 5,
  backoff: {
    type: 'exponential' as const,
    delay: 10_000, // 10s 20s, 40s, 80s
  },
};

@Injectable()
export class QuestionsService {
  constructor(
    @InjectQueue('llm-generation') private readonly queue: Queue,
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
  ) {}

  expandPayloadToJobs(
    payload: GenerateQuestionsDto,
    orgId: string,
  ): GenerateTopicBatchJobPayload[] {
    const jobs: GenerateTopicBatchJobPayload[] = [];
    const {
      topicConfigurations,
      levelId,
      domainName,
      learningObjectives,
      targetAudience,
      focusAreas,
      bloomsLevel,
      questionStyle,
      difficultyDistribution,
      questionCounts,
    } = payload;

    if (
      !topicConfigurations ||
      !Array.isArray(topicConfigurations) ||
      topicConfigurations.length === 0
    ) {
      throw new BadRequestException(
        'topicConfigurations must be a non-empty array',
      );
    }

    const baseContext: Omit<GenerateTopicBatchJobPayload, 'topic' | 'count'> = {
      orgId,
      levelId: levelId ?? null,
      domainName,
      learningObjectives,
      targetAudience,
      focusAreas,
      bloomsLevel,
      questionStyle,
      difficultyDistribution,
      questionCounts,
    };

    for (const cfg of topicConfigurations) {
      const topic = cfg.topicName;
      const count = cfg.totalQuestions;
      if (!topic || !Number.isInteger(count) || count <= 0) continue;

      const perTopicCtx: Omit<GenerateTopicBatchJobPayload, 'topic' | 'count'> =
        {
          ...baseContext,
          topicName: cfg.topicName,
          topicDescription: cfg.topicDescription,
          difficultyDistribution:
            cfg.difficultyDistribution ?? difficultyDistribution,
          questionCounts: cfg.questionCounts ?? questionCounts,
        };

      const numBatches = Math.ceil(count / BATCH_SIZE);
      for (let i = 0; i < numBatches; i++) {
        const countForThisJob =
          i < numBatches - 1
            ? BATCH_SIZE
            : count - (numBatches - 1) * BATCH_SIZE;
        jobs.push({
          topic,
          count: countForThisJob,
          ...perTopicCtx,
        });
      }
    }

    if (jobs.length === 0) {
      throw new BadRequestException(
        'No valid topic counts (each topic must have a positive integer count)',
      );
    }

    return jobs;
  }

  async enqueueGeneration(
    payload: GenerateQuestionsDto,
    orgId: string,
  ): Promise<{
    message: string;
    totalJobs: number;
    jobIds: string[];
  }> {
    const jobs = this.expandPayloadToJobs(payload, orgId);
    const jobIds: string[] = [];

    for (let i = 0; i < jobs.length; i++) {
      const job = await this.queue.add(JOB_NAME, jobs[i], {
        jobId: `gen-${Date.now()}-${i}-${jobs[i].topic}-${jobs[i].count}`,
        ...JOB_OPTS,
      });
      jobIds.push(job.id ?? String(i));
    }

    return {
      message: 'Question generation jobs enqueued. You are not blocked.',
      totalJobs: jobs.length,
      jobIds,
    };
  }

  async create(createQuestionDto: CreateQuestionDto) {
    const [row] = await this.db
      .insert(zuvyQuestions)
      .values({
        orgId: createQuestionDto.orgId ?? null,
        domainName: createQuestionDto.domainName,
        topicName: createQuestionDto.topicName,
        topicDescription: createQuestionDto.topicDescription,
        learningObjectives: createQuestionDto.learningObjectives ?? null,
        targetAudience: createQuestionDto.targetAudience ?? null,
        focusAreas: createQuestionDto.focusAreas ?? null,
        bloomsLevel: createQuestionDto.bloomsLevel ?? null,
        questionStyle: createQuestionDto.questionStyle ?? null,
        question: createQuestionDto.question,
        difficulty: createQuestionDto.difficulty ?? null,
        language: createQuestionDto.language ?? null,
        options: createQuestionDto.options,
        correctOption: createQuestionDto.correctOption,
        difficultyDistribution: createQuestionDto.difficultyDistribution ?? null,
        questionCounts: createQuestionDto.questionCounts ?? null,
        levelId: createQuestionDto.levelId ?? null,
      })
      .returning();

    return row;
  }

  async createMany(rows: CreateQuestionDto[]) {
    if (!rows || rows.length === 0) return [];
    return this.db
      .insert(zuvyQuestions)
      .values(
        rows.map((r) => ({
          orgId: r.orgId ?? null,
          domainName: r.domainName,
          topicName: r.topicName,
          topicDescription: r.topicDescription,
          learningObjectives: r.learningObjectives ?? null,
          targetAudience: r.targetAudience ?? null,
          focusAreas: r.focusAreas ?? null,
          bloomsLevel: r.bloomsLevel ?? null,
          questionStyle: r.questionStyle ?? null,
          question: r.question,
          difficulty: r.difficulty ?? null,
          language: r.language ?? null,
          options: r.options,
          correctOption: r.correctOption,
          difficultyDistribution: r.difficultyDistribution ?? null,
          questionCounts: r.questionCounts ?? null,
          levelId: r.levelId ?? null,
        })),
      )
      .returning();
  }

  /**
   * Create many questions and enqueue outbox events for indexing,
   * all in a single transaction so we never index a question that wasn't saved.
   */
  async createManyWithOutbox(rows: CreateQuestionDto[]) {
    if (!rows || rows.length === 0) return [];

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(zuvyQuestions)
        .values(
          rows.map((r) => ({
            orgId: r.orgId ?? null,
            domainName: r.domainName,
            topicName: r.topicName,
            topicDescription: r.topicDescription,
            learningObjectives: r.learningObjectives ?? null,
            targetAudience: r.targetAudience ?? null,
            focusAreas: r.focusAreas ?? null,
            bloomsLevel: r.bloomsLevel ?? null,
            questionStyle: r.questionStyle ?? null,
            question: r.question,
            difficulty: r.difficulty ?? null,
            language: r.language ?? null,
            options: r.options,
            correctOption: r.correctOption,
            difficultyDistribution: r.difficultyDistribution ?? null,
            questionCounts: r.questionCounts ?? null,
            levelId: r.levelId ?? null,
          })),
        )
        .returning();

      if (inserted.length > 0) {
        await tx.insert(questionIndexOutbox).values(
          inserted.map((q) => ({
            questionId: q.id,
            status: 'pending',
          })),
        );
      }

      return inserted;
    });
  }

  /**
   * Fetch question texts for a given domain so we can include them in the LLM prompt
   * and avoid generating exact duplicates.
   */
  async getQuestionTextsByDomain(
    domainName: string,
    limit = 200,
  ): Promise<string[]> {
    if (!domainName?.trim()) return [];
    const rows = await this.db
      .select({ question: zuvyQuestions.question })
      .from(zuvyQuestions)
      .where(eq(zuvyQuestions.domainName, domainName.trim()))
      .limit(limit);
    return rows.map((r) => r.question).filter(Boolean);
  }

  findAll() {
    return `This action returns all questions`;
  }

  findOne(id: number) {
    return `This action returns a #${id} question`;
  }

  update(id: number, updateQuestionDto: UpdateQuestionDto) {
    return `This action updates a #${id} question`;
  }

  remove(id: number) {
    return `This action removes a #${id} question`;
  }
}
