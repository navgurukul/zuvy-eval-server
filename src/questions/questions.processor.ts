import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { generateMcqPromptFromSpec } from 'src/ai-assessment/system_prompts/system_prompts';
import { parseLlmMcq } from 'src/llm/llm_response_parsers/mcqParser';
import { LlmService } from 'src/llm/llm.service';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { VectorService } from 'src/vector/vector.service';
import { GenerateTopicBatchJobPayload } from './dto/generate-questions.dto';
import { QuestionsService } from './questions.service';

const JOB_NAME = 'generate-topic-batch';
const QDRANT_QUESTIONS_COLLECTION = 'QUESTIONS';

@Processor('llm-generation')
export class QuestionsProcessor extends WorkerHost {
  private readonly logger = new Logger(QuestionsProcessor.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly questionsService: QuestionsService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly vectorService: VectorService,
  ) {
    super();
  }

  override async process(job: Job<GenerateTopicBatchJobPayload, void, string>, token?: string): Promise<void> {
    if (job.name === JOB_NAME) {
      return this.handleGenerateTopicBatch(job);
    }
    throw new Error(`Unknown job name: ${job.name}`);
  }

  private async handleGenerateTopicBatch(
    job: Job<GenerateTopicBatchJobPayload, void, string>,
  ) {
    try {
    const { topic, count, levelId, orgId } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;

    if (attempt > 1) {
      this.logger.log(
        `Retry attempt ${attempt} for job ${job.id} (topic=${topic}); previous attempts failed (e.g. rate limit).`,
      );
    }

    this.logger.log(
      `Processing job ${job.id}: topic=${topic}, count=${count}, levelId=${levelId ?? 'null'}`,
    );

    const domainName = job.data.domainName ?? '';
    let existingTexts: string[] = [];
    if (domainName) {
      try {
        existingTexts = await this.questionsService.getQuestionTextsByDomain(
          domainName,
          200,
        );
      } catch (err) {
        this.logger.warn(
          `Job ${job.id}: could not load existing questions for domain "${domainName}", continuing without them: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (existingTexts.length > 0) {
      this.logger.log(
        `Job ${job.id}: including ${existingTexts.length} existing questions for domain "${domainName}" in prompt to avoid duplicates.`,
      );
    }

    const prompt = generateMcqPromptFromSpec(job.data, existingTexts);

    const aiResponse = await this.llmService.generateCompletion(prompt);
    if (!aiResponse?.text) {
      throw new Error(
        'LLM returned no response (rate limit or provider down). Job will retry with backoff.',
      );
    }
    const parsed = await parseLlmMcq(aiResponse.text);

    const domainNameForInsert = job.data.domainName ?? 'Unknown';
    const topicName = job.data.topicName ?? topic;
    const topicDescription = job.data.topicDescription ?? '';

    const inserted = await this.questionsService.createMany(
      (parsed.evaluations ?? []).map((q) => {
        const rawLevel = (q as any).level;
        const normalizedLevel =
          typeof rawLevel === 'string'
            ? rawLevel.trim().toUpperCase()
            : null;
        const levelBand: 'A' | 'B' | 'C' | 'D' | 'E' | null =
          normalizedLevel && ['A', 'B', 'C', 'D', 'E'].includes(normalizedLevel)
            ? (normalizedLevel as 'A' | 'B' | 'C' | 'D' | 'E')
            : (levelId ?? null) ?? null;

        return {
          orgId: orgId ?? undefined,
          domainName: domainNameForInsert,
          topicName,
          topicDescription,
          learningObjectives: job.data.learningObjectives,
          targetAudience: job.data.targetAudience,
          focusAreas: job.data.focusAreas,
          bloomsLevel: job.data.bloomsLevel,
          questionStyle: job.data.questionStyle,
          difficultyDistribution: job.data.difficultyDistribution,
          questionCounts: job.data.questionCounts,
          levelId: levelBand,
          question: q.question,
          difficulty: q.difficulty,
          language: q.language,
          options: q.options as any,
          correctOption: Number(q.correctOption),
        };
      }),
    );

    if (inserted.length > 0) {
      // Narrow type for indexer: only fields it actually uses for embeddings and payload.
      const rowsForIndex = inserted.map((row) => ({
        id: row.id,
        question: row.question,
        topicName: row.topicName,
        topicDescription: row.topicDescription,
        difficulty: row.difficulty,
        levelId: row.levelId as 'A' | 'B' | 'C' | 'D' | 'E' | null,
        domainName: row.domainName,
      }));
      await this.indexQuestionsInQdrant(rowsForIndex);
    }

    this.logger.log(
      `Job ${job.id} completed: inserted ${parsed.evaluations?.length ?? 0} questions for topic ${topic}`,
    );
    } catch (error) {
      this.logger.error('Error processing job:', error);
      throw error;
    }
  }

  private async indexQuestionsInQdrant(
    rows: Array<{
      id: number;
      question: string;
      topicName: string | null;
      topicDescription: string | null;
      difficulty: string | null;
      levelId: 'A' | 'B' | 'C' | 'D' | 'E' | null;
      domainName: string | null;
    }>,
  ): Promise<void> {
    try {
      await this.vectorService.ensureCollection(
        QDRANT_QUESTIONS_COLLECTION,
        this.embeddingsService.dimension || 1536,
      );
  
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
  
      await this.vectorService.upsert({
        collectionName: QDRANT_QUESTIONS_COLLECTION,
        points,
      });
  
      this.logger.log(
        `Indexed ${points.length} questions into Qdrant collection "${QDRANT_QUESTIONS_COLLECTION}"`,
      );
    } catch (error) {
      this.logger.error('Error indexing questions in Qdrant:', error);
      throw error;
    }
  }
}
