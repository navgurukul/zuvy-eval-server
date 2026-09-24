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
import { shuffleMcqOptionOrder } from './mcq-option-shuffle.util';

const JOB_NAME = 'generate-topic-batch';
const QDRANT_QUESTIONS_COLLECTION = 'QUESTIONS';

/**
 * How many existing questions to show the model as "do not repeat these".
 *
 * The old SQL path sent up to 200 whole questions matched on an exact topic
 * name. Semantic neighbours are far more relevant per item, so a much smaller
 * set does more work for a fraction of the prompt.
 */
const DEDUPE_NEIGHBOURS = 40;

const OPTION_KEYS = ['1', '2', '3', '4'];
const VAGUE_OPTION = /^(all|none) of the above$/i;

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

  /**
   * Structural checks the prompt asks for but nothing enforced until now.
   *
   * Same lesson as shuffleMcqOptionOrder: an instruction in a prompt is not a
   * guarantee, so anything mechanically checkable is checked in code. These
   * matter beyond tidiness - shuffleMcqOptionOrder silently skips a question
   * whose options are not exactly "1".."4", so a malformed item would be
   * stored unshuffled, and an out-of-range correctOption would key an option
   * that does not exist.
   *
   * Throws on a structural defect so the job retries, matching how the batch
   * size and difficulty checks already behave.
   */
  private assertWellFormedMcqs(
    evaluations: Array<Record<string, any>>,
    jobId: string | number | undefined,
  ): void {
    const problems: string[] = [];

    evaluations.forEach((q, index) => {
      const where = `question ${index + 1}`;
      const options = q.options;

      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        problems.push(`${where}: options is not an object`);
        return;
      }

      const keys = Object.keys(options);
      if (keys.length !== OPTION_KEYS.length || !OPTION_KEYS.every((k) => k in options)) {
        problems.push(`${where}: options keys are [${keys.join(', ')}], expected 1-4`);
        return;
      }

      const texts = OPTION_KEYS.map((k) => options[k]);
      if (texts.some((t) => typeof t !== 'string' || !t.trim())) {
        problems.push(`${where}: one or more options are empty`);
        return;
      }

      const normalized = texts.map((t) => t.trim().toLowerCase());
      if (new Set(normalized).size !== normalized.length) {
        problems.push(`${where}: duplicate option texts`);
      }

      const correct = Number(q.correctOption);
      if (!Number.isInteger(correct) || !OPTION_KEYS.includes(String(correct))) {
        problems.push(`${where}: correctOption is ${q.correctOption}, expected 1-4`);
      }

      // Stylistic only: the prompt forbids these, but one slipping through
      // does not make the stored answer wrong, so it is not worth a retry.
      const vague = texts.filter((t) => VAGUE_OPTION.test(String(t).trim()));
      if (vague.length) {
        this.logger.warn(
          `Job ${jobId}: ${where} uses "${vague[0]}", which the prompt forbids.`,
        );
      }

      if (!q.solution || !String(q.solution).trim()) {
        this.logger.warn(
          `Job ${jobId}: ${where} came back with no written solution; the ` +
            `solve-before-answer check could not be applied to it.`,
        );
      }
    });

    if (problems.length) {
      throw new Error(
        `Malformed MCQs for job ${jobId} (${problems.length}/${evaluations.length}): ` +
          problems.slice(0, 5).join('; '),
      );
    }
  }

  /**
   * Nearest existing questions by meaning, for the "do not repeat these" block.
   *
   * Deliberately unfiltered by topic. Topic names in this database are heavily
   * fragmented ("Time and Distance" vs "Time And Distance", four spellings of
   * Function and Scopes, topics named "115"), so the exact-match SQL lookup
   * this replaces retrieves nothing at all for a fragmented topic. Similarity
   * crosses those variants, which is the whole point.
   *
   * Returns null on any failure so the caller can fall back rather than fail a
   * generation job because the vector store is unavailable.
   */
  private async findSimilarQuestionTexts(
    job: Job<GenerateTopicBatchJobPayload, void, string>,
    topicName: string,
    topicDescription: string,
    orgId: number | undefined,
  ): Promise<string[] | null> {
    try {
      const queryText = [
        topicName,
        topicDescription,
        ...(Array.isArray(job.data.subtopics) ? job.data.subtopics : []),
        job.data.focusAreas ?? '',
        job.data.learningObjectives ?? '',
      ]
        .filter(Boolean)
        .join(' ');

      if (!queryText.trim()) return null;

      const queryVector = await this.embeddingsService.embed(queryText);
      const hits = await this.vectorService.search({
        collectionName: QDRANT_QUESTIONS_COLLECTION,
        queryVector,
        limit: DEDUPE_NEIGHBOURS,
      });

      const ids = hits
        .map((h) => Number(h.payload?.questionId ?? h.id))
        .filter((id) => Number.isFinite(id));

      if (!ids.length) return null;

      // The vector store carries no orgId, so tenant scoping happens here.
      return await this.questionsService.getQuestionTextsByIds(ids, orgId);
    } catch (err) {
      this.logger.warn(
        `Job ${job.id}: semantic dedupe lookup failed, falling back to topic-name match: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }

  private async handleGenerateTopicBatch(
    job: Job<GenerateTopicBatchJobPayload, void, string>,
  ) {
    try {
    const { topic, count, levelId, orgId } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;

    const resolved = await this.questionsService.resolveCanonicalTopic(
      orgId,
      job.data.topicName ?? topic,
    );
    const topicName = resolved.topicName || (job.data.topicName ?? topic);
    const topicDescription =
      job.data.topicDescription?.trim() || resolved.topicDescription || '';

    if (attempt > 1) {
      this.logger.log(
        `Retry attempt ${attempt} for job ${job.id} (topic=${topicName}); previous attempts failed (e.g. rate limit).`,
      );
    }

    this.logger.log(
      `Processing job ${job.id}: appending ${count} questions to topic=${topicName}, orgId=${orgId ?? 'none'}, levelId=${levelId ?? 'null'}`,
    );

    let existingTexts: string[] = [];
    let dedupeSource = 'semantic';

    const similar = await this.findSimilarQuestionTexts(
      job,
      topicName,
      topicDescription,
      orgId,
    );

    if (similar && similar.length > 0) {
      existingTexts = similar;
    } else {
      // Exact topic-name match. Misses every variant spelling, but it needs no
      // vector store, so it keeps generation working when that is down.
      dedupeSource = 'topic-name';
      try {
        existingTexts = await this.questionsService.getQuestionTextsByTopic(
          topicName,
          orgId,
          200,
        );
      } catch (err) {
        this.logger.warn(
          `Job ${job.id}: could not load existing questions for topic "${topicName}", continuing without them: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (existingTexts.length > 0) {
      this.logger.log(
        `Job ${job.id}: including ${existingTexts.length} existing questions (${dedupeSource}) ` +
          `for topic "${topicName}" in prompt to avoid duplicates.`,
      );
    }

    const prompt = generateMcqPromptFromSpec(
      { ...job.data, topic: topicName, topicName, topicDescription },
      existingTexts,
    );

    const aiResponse = await this.llmService.generateCompletion(prompt);
    if (!aiResponse?.text) {
      throw new Error(
        'LLM returned no response (rate limit or provider down). Job will retry with backoff.',
      );
    }
    const parsed = await parseLlmMcq(aiResponse.text);
    const evaluations = parsed.evaluations ?? [];
    this.assertWellFormedMcqs(evaluations as Array<Record<string, any>>, job.id);
    const requiredBatchCounts = job.data.batchQuestionCounts;
    if (evaluations.length !== count) {
      throw new Error(
        `Batch size mismatch for job ${job.id}: expected ${count}, got ${evaluations.length}`,
      );
    }
    if (requiredBatchCounts) {
      const actualCounts = evaluations.reduce(
        (acc, q) => {
          const difficulty = String(q.difficulty ?? '').trim().toLowerCase();
          if (difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard') {
            acc[difficulty] += 1;
          }
          return acc;
        },
        { easy: 0, medium: 0, hard: 0 },
      );
      if (
        actualCounts.easy !== requiredBatchCounts.easy ||
        actualCounts.medium !== requiredBatchCounts.medium ||
        actualCounts.hard !== requiredBatchCounts.hard
      ) {
        throw new Error(
          `Difficulty mismatch for job ${job.id}: expected easy=${requiredBatchCounts.easy}, medium=${requiredBatchCounts.medium}, hard=${requiredBatchCounts.hard}; got easy=${actualCounts.easy}, medium=${actualCounts.medium}, hard=${actualCounts.hard}`,
        );
      }
    }

    const requestedByUserId = job.data.requestedByUserId;
    const inserted = await this.questionsService.createManyWithOutbox(
      evaluations.map((q) => {
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

        const { options: shuffledOptions, correctOption: shuffledCorrectOption } =
          shuffleMcqOptionOrder(
            q.options as Record<string, string>,
            Number(q.correctOption),
          );

        return {
          orgId: orgId ?? undefined,
          topicName,
          topicDescription,
          subtopics: job.data.subtopics,
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
          options: shuffledOptions as any,
          correctOption: shuffledCorrectOption,
        };
      }),
      requestedByUserId,
    );

    this.logger.log(
      `Job ${job.id} completed: appended ${inserted.length} questions for topic ${topicName} (existing pool preserved)`,
    );
    } catch (error) {
      this.logger.error('Error processing job:', error);
      throw error;
    }
  }
}
