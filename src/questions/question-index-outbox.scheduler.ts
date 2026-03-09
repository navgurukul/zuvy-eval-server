import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

const OUTBOX_QUEUE = 'question-index-outbox';
const POLL_JOB_NAME = 'poll-outbox';

@Injectable()
export class QuestionIndexOutboxScheduler implements OnModuleInit {
  private readonly logger = new Logger(QuestionIndexOutboxScheduler.name);

  constructor(
    @InjectQueue(OUTBOX_QUEUE) private readonly outboxQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // Ensure a repeatable poll-outbox job exists (idempotent via jobId)
    await this.outboxQueue.add(
      POLL_JOB_NAME,
      {},
      {
        jobId: POLL_JOB_NAME,
        repeat: { every: 5_000 }, // every 5 seconds
        removeOnComplete: true,
      },
    );

    this.logger.log(
      `Scheduled repeatable "${POLL_JOB_NAME}" job on "${OUTBOX_QUEUE}" queue (every 5000ms).`,
    );
  }
}
