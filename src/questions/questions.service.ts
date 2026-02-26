import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import {
  GenerateQuestionsDto,
  GenerateTopicBatchJobPayload,
} from './dto/generate-questions.dto';

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
  ) {}

  expandPayloadToJobs(payload: GenerateQuestionsDto): GenerateTopicBatchJobPayload[] {
    const jobs: GenerateTopicBatchJobPayload[] = [];
    const { topics, levelId } = payload;

    if (!topics || typeof topics !== 'object' || Object.keys(topics).length === 0) {
      throw new BadRequestException('topics must be a non-empty object (topic name -> count)');
    }

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
          levelId: levelId ?? null,
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

  create(createQuestionDto: CreateQuestionDto) {
    return 'This action adds a new question';
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
