import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { generateMcqPromptFromSpec } from 'src/ai-assessment/system_prompts/system_prompts';
import { parseLlmMcq } from 'src/llm/llm_response_parsers/mcqParser';
import { LlmService } from 'src/llm/llm.service';
import { GenerateTopicBatchJobPayload } from './dto/generate-questions.dto';
import { QuestionsService } from './questions.service';

const JOB_NAME = 'generate-topic-batch';

@Processor('llm-generation')
export class QuestionsProcessor extends WorkerHost {
  private readonly logger = new Logger(QuestionsProcessor.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly questionsService: QuestionsService,
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
    const { topic, count, levelId } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;

    if (attempt > 1) {
      this.logger.log(
        `Retry attempt ${attempt} for job ${job.id} (topic=${topic}); previous attempts failed (e.g. rate limit).`,
      );
    }

    this.logger.log(
      `Processing job ${job.id}: topic=${topic}, count=${count}, levelId=${levelId ?? 'null'}`,
    );

    const prompt = generateMcqPromptFromSpec(job.data);

    const aiResponse = await this.llmService.generateCompletion(prompt);
    if (!aiResponse?.text) {
      throw new Error(
        'LLM returned no response (rate limit or provider down). Job will retry with backoff.',
      );
    }
    const parsed = await parseLlmMcq(aiResponse.text);

    const domainName = job.data.domainName ?? 'Unknown';
    const topicName = job.data.topicName ?? topic;
    const topicDescription = job.data.topicDescription ?? '';

    await this.questionsService.createMany(
      (parsed.evaluations ?? []).map((q) => ({
        domainName,
        topicName,
        topicDescription,
        learningObjectives: job.data.learningObjectives,
        targetAudience: job.data.targetAudience,
        focusAreas: job.data.focusAreas,
        bloomsLevel: job.data.bloomsLevel,
        questionStyle: job.data.questionStyle,
        difficultyDistribution: job.data.difficultyDistribution,
        questionCounts: job.data.questionCounts,
        levelId: levelId ?? null,
        question: q.question,
        difficulty: q.difficulty,
        language: q.language,
        options: q.options as any,
        correctOption: Number(q.correctOption),
      })),
    );

    this.logger.log(
      `Job ${job.id} completed: inserted ${parsed.evaluations?.length ?? 0} questions for topic ${topic}`,
    );
  }
}
