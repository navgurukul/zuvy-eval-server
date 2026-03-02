import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Inject } from '@nestjs/common';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import {
  GenerateQuestionsDto,
  GenerateTopicBatchJobPayload,
} from './dto/generate-questions.dto';
import { zuvyQuestions } from './schema/zuvy-questions.schema';

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

  expandPayloadToJobs(payload: GenerateQuestionsDto): GenerateTopicBatchJobPayload[] {
    const jobs: GenerateTopicBatchJobPayload[] = [];
    const {
      topics,
      levelId,
      domainName,
      topicName,
      topicDescription,
      learningObjectives,
      targetAudience,
      focusAreas,
      bloomsLevel,
      questionStyle,
      difficultyDistribution,
      questionCounts,
    } = payload;

    if (!topics || typeof topics !== 'object' || Object.keys(topics).length === 0) {
      throw new BadRequestException('topics must be a non-empty object (topic name -> count)');
    }

    const baseContext: Omit<GenerateTopicBatchJobPayload, 'topic' | 'count'> = {
      levelId: levelId ?? null,
      domainName,
      topicName,
      topicDescription,
      learningObjectives,
      targetAudience,
      focusAreas,
      bloomsLevel,
      questionStyle,
      difficultyDistribution,
      questionCounts,
    };

    for (const [topic, totalCount] of Object.entries(topics)) {
      const count = Number(totalCount);
      if (!topic || !Number.isInteger(count) || count <= 0) continue;
      const numBatches = Math.ceil(count / BATCH_SIZE);
      for (let i = 0; i < numBatches; i++) {
        const countForThisJob =
          i < numBatches - 1
            ? BATCH_SIZE
            : count - (numBatches - 1) * BATCH_SIZE;
        jobs.push({
          topic,
          count: countForThisJob,
          ...baseContext,
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

  async enqueueGeneration(payload: GenerateQuestionsDto): Promise<{
    message: string;
    totalJobs: number;
    jobIds: string[];
  }> {
    const jobs = this.expandPayloadToJobs(payload);
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
