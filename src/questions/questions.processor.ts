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

    const requestedByUserId = job.data.requestedByUserId;
    const inserted = await this.questionsService.createManyWithOutbox(
      (parsed.evaluations ?? []).map((q) => {
        const rawLevel = (q as any).level;
        const normalizedLevel =
          typeof rawLevel === 'string'
            ? rawLevel.trim().toUpperCase()
            : null;
        const allowedBands = ['A+', 'A', 'B', 'C', 'D', 'E'] as const;
        const levelBand: (typeof allowedBands)[number] | null =
          normalizedLevel && (allowedBands as readonly string[]).includes(normalizedLevel)
            ? (normalizedLevel as (typeof allowedBands)[number])
            : levelId &&
                (allowedBands as readonly string[]).includes(String(levelId).toUpperCase())
              ? (String(levelId).toUpperCase() as (typeof allowedBands)[number])
              : null;

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
      requestedByUserId,
    );

    this.logger.log(
      `Job ${job.id} completed: inserted ${parsed.evaluations?.length ?? 0} questions for topic ${topic}`,
    );
    } catch (error) {
      this.logger.error('Error processing job:', error);
      throw error;
    }
  }
}
