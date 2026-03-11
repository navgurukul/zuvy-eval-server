import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { zuvyQuestions, questionIndexOutbox } from './schema/zuvy-questions.schema';
import { inArray, eq } from 'drizzle-orm';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { VectorService } from 'src/vector/vector.service';
import { NotificationzGateway } from 'src/notificationz/notificationz.gateway';

const INDEX_QUEUE = 'question-index';
const QDRANT_QUESTIONS_COLLECTION = 'QUESTIONS';

interface IndexQuestionsJobData {
  questionIds: number[];
  /** User ids to notify when indexing completes (each gets a WS event). */
  requestedByUserIds?: string[];
}

@Processor(INDEX_QUEUE)
export class QuestionIndexProcessor extends WorkerHost {
  private readonly logger = new Logger(QuestionIndexProcessor.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    private readonly embeddingsService: EmbeddingsService,
    private readonly vectorService: VectorService,
    @InjectQueue('question-index-outbox') private readonly outboxQueue: Queue,
    private readonly notificationzGateway: NotificationzGateway,
  ) {
    super();
  }

  override async process(job: Job<IndexQuestionsJobData>): Promise<void> {
    if (job.name !== 'index-questions') {
      this.logger.warn(`Unknown job name ${job.name} on ${INDEX_QUEUE}`);
      return;
    }

    const { questionIds } = job.data;
    if (!questionIds || questionIds.length === 0) {
      this.logger.warn('index-questions job received no questionIds.');
      return;
    }

    try {
      // 1) Load questions from Postgres.
      const rows = await this.db
        .select({
          id: zuvyQuestions.id,
          question: zuvyQuestions.question,
          topicName: zuvyQuestions.topicName,
          topicDescription: zuvyQuestions.topicDescription,
          difficulty: zuvyQuestions.difficulty,
          levelId: zuvyQuestions.levelId,
          domainName: zuvyQuestions.domainName,
        })
        .from(zuvyQuestions)
        .where(inArray(zuvyQuestions.id, questionIds));

      if (!rows.length) {
        this.logger.warn(
          `No questions found in DB for ids: ${questionIds.join(', ')}`,
        );
        return;
      }

      // 2) Ensure Qdrant collection exists.
      await this.vectorService.ensureCollection(
        QDRANT_QUESTIONS_COLLECTION,
        this.embeddingsService.dimension || 1536,
      );

      // 3) Build texts and embeddings.
      const texts = rows.map((r) =>
        [
          r.question,
          r.topicName ?? '',
          r.topicDescription ?? '',
          r.difficulty ?? '',
        ]
          .filter(Boolean)
          .join(' '),
      );
      const vectors = await this.embeddingsService.embedMany(texts);

      // 4) Build Qdrant points.
      const points = rows
        .map((row, i) => ({
          id: String(row.id),
          vector: vectors[i] ?? [],
          payload: {
            questionId: row.id,
            levelId: row.levelId ?? null,
            topic: row.topicName ?? '',
            difficulty: row.difficulty ?? null,
            topicDescription: row.topicDescription ?? '',
            domainName: row.domainName ?? '',
          },
        }))
        .filter((p) => p.vector.length > 0);

      if (points.length === 0) {
        this.logger.warn('No valid embeddings; skipping Qdrant upsert.');
        return;
      }

      // 5) Upsert into Qdrant.
      await this.vectorService.upsert({
        collectionName: QDRANT_QUESTIONS_COLLECTION,
        points,
      });

      this.logger.log(
        `Indexed ${points.length} questions into Qdrant collection "${QDRANT_QUESTIONS_COLLECTION}"`,
      );

      // 6) Notify only the user(s) who requested this batch (one event per user).
      const requestedByUserIds = job.data.requestedByUserIds ?? [];
      const payload = { count: points.length, questionIds };
      for (const userId of requestedByUserIds) {
        if (userId) {
          this.notificationzGateway.server
            .to(`user:${userId}`)
            .emit('questions:ready', payload);
        }
      }

      // 7) Mark outbox events as done.
      const now = new Date().toISOString();
      await this.db
        .update(questionIndexOutbox)
        .set({
          status: 'done',
          lastError: null,
          updatedAt: now as any,
        })
        .where(inArray(questionIndexOutbox.questionId, questionIds));
    } catch (error) {
      this.logger.error('Error indexing questions in Qdrant:', error);

      const now = new Date().toISOString();
      await this.db
        .update(questionIndexOutbox)
        .set({
          status: 'failed',
          lastError:
            error instanceof Error ? error.message : String(error),
          updatedAt: now as any,
        })
        .where(inArray(questionIndexOutbox.questionId, job.data.questionIds));

      throw error;
    }
  }
}

