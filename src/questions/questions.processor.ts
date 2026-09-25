import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  generateMcqPromptFromSpec,
  parseVerifierVerdict,
  verifyMcqAnswerPrompt,
} from 'src/ai-assessment/system_prompts/system_prompts';
import { parseLlmMcq } from 'src/llm/llm_response_parsers/mcqParser';
import { LlmService } from 'src/llm/llm.service';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { VectorService } from 'src/vector/vector.service';
import { GenerateTopicBatchJobPayload } from './dto/generate-questions.dto';
import { QuestionsService } from './questions.service';
import { shuffleMcqOptionOrder } from './mcq-option-shuffle.util';
import { findDuplicateQuestions } from './question-similarity.util';

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

/**
 * How many of the topic's most recent questions to load alongside the
 * semantic neighbours.
 *
 * A 60-question request fans out to six independent jobs of ten. None of them
 * can see the others through the vector store: indexing runs off an outbox
 * poller, so a sibling batch inserted seconds ago is not searchable yet. The
 * recency list is the only path that sees those rows, which is why it now runs
 * alongside semantic retrieval instead of only as its fallback.
 */
const RECENT_TOPIC_QUESTIONS = 60;

/** Upper bound on existing questions pasted into the generation prompt. */
const MAX_EXISTING_TEXTS = 120;

/**
 * Neighbours to pull per generated question when checking it against the bank.
 *
 * Small on purpose. This search starts from the generated question itself, so
 * a true repeat ranks at or near the top; a wide net would only add texts the
 * token rules then reject, at the cost of a bigger id lookup.
 */
const BANK_NEIGHBOURS = 8;

/**
 * Verifier calls to keep in flight at once. Generation batches are ten
 * questions, so this finishes a batch in two waves without presenting a burst
 * large enough to trip provider rate limits.
 */
const VERIFY_CONCURRENCY = 5;

/**
 * Whether to take a second opinion on each keyed answer before storing it.
 *
 * On by default: shipping a question whose correct option is wrong is the
 * worst failure this service has, because it marks a correct student answer
 * wrong and the explanation then argues for the wrong option. It roughly
 * doubles the LLM cost of generation, so there is an escape hatch, but it
 * has to be set deliberately.
 */
const VERIFY_GENERATED_ANSWERS =
  String(process.env.VERIFY_GENERATED_ANSWERS ?? 'true').toLowerCase() !== 'false';

/**
 * Which provider solves the verification question first.
 *
 * Defaults to the provider that did NOT generate the batch. Generation runs on
 * OpenAI, so asking OpenAI to re-check its own work shares its blind spots: a
 * question is keyed wrongly because of one specific mistake, and the model that
 * made it tends to make it again when re-solving. A different model family
 * fails differently, which is what makes the second opinion worth paying for.
 *
 * LlmService still falls back to the other provider, so if Gemini is
 * unconfigured or down this degrades to same-model checking rather than to no
 * checking. Set VERIFIER_PROVIDER=openai to pin it back to one provider.
 */
const VERIFIER_PROVIDER: 'openai' | 'genai' =
  String(process.env.VERIFIER_PROVIDER ?? 'genai').toLowerCase() === 'openai'
    ? 'openai'
    : 'genai';

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
   * Second opinion on every keyed answer, from a model that cannot see the key.
   *
   * This is the only check in the pipeline that can catch a generator which
   * reasoned wrongly but consistently. assertWellFormedMcqs passes on a
   * confidently wrong answer, and the generator's own "self-validation pass"
   * is the same reasoning re-run, so it agrees with itself: the batch that
   * keyed 288 for a permutation question whose answer is 144 passed every
   * check that existed.
   *
   * Three outcomes, and the difference between the last two matters:
   *
   *   - verifier agrees          -> keep the question.
   *   - verifier picks another   -> drop it. One of the two models is wrong
   *                                 and we cannot tell which, so shipping it
   *                                 is a coin flip on a student's score.
   *   - verifier says "none"     -> drop it. This is the case where the right
   *                                 answer is missing from the options
   *                                 entirely, which a forced choice hides.
   *   - verifier unreadable/down -> KEEP it. An unavailable provider must not
   *                                 silently empty a batch; it degrades to the
   *                                 old behaviour and says so in the log.
   *
   * Dropping rather than re-keying is deliberate. Measurement put the verifier
   * itself at fault in a meaningful share of disagreements, so overwriting a
   * stored answer on one dissenting opinion would introduce its own errors.
   * Losing a question costs nothing a regeneration cannot replace.
   */
  private async verifyKeyedAnswers(
    candidates: Array<{ q: Record<string, any>; index: number }>,
    jobId: string | number | undefined,
  ): Promise<Set<number>> {
    const rejected = new Set<number>();
    if (!candidates.length) return rejected;

    let unreadable = 0;

    const verifyOne = async ({ q, index }: { q: Record<string, any>; index: number }) => {
      const prompt = verifyMcqAnswerPrompt({
        question: String(q.question ?? ''),
        options: q.options as Record<string, string>,
      });

      let verdict: ReturnType<typeof parseVerifierVerdict> = null;
      try {
        const response = await this.llmService.generateCompletionPreferring(
          VERIFIER_PROVIDER,
          prompt,
        );
        verdict = parseVerifierVerdict(response?.text);
      } catch (err) {
        this.logger.warn(
          `Job ${jobId}: verifier call failed for question ${index + 1}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }

      if (!verdict) {
        // No signal. Keep the question rather than fail open in the
        // destructive direction.
        unreadable += 1;
        return;
      }

      const keyed = Number(q.correctOption);

      if (verdict.correctOption === null) {
        rejected.add(index);
        this.logger.warn(
          `[generation-rejected] job=${jobId} question=${index + 1} reason=no-correct-option ` +
            `keyed=${keyed} verifierAnswer=${JSON.stringify(verdict.computedAnswer)} ` +
            `question=${JSON.stringify(String(q.question ?? '').slice(0, 120))}`,
        );
        return;
      }

      if (verdict.correctOption !== keyed) {
        rejected.add(index);
        this.logger.warn(
          `[generation-rejected] job=${jobId} question=${index + 1} reason=answer-disagreement ` +
            `keyed=${keyed} verifier=${verdict.correctOption} ` +
            `verifierAnswer=${JSON.stringify(verdict.computedAnswer)} ` +
            `question=${JSON.stringify(String(q.question ?? '').slice(0, 120))}`,
        );
      }
    };

    // Fixed-size pool rather than Promise.all over the whole batch, so a
    // larger batch size later cannot turn into a burst of parallel calls.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(VERIFY_CONCURRENCY, candidates.length) }, async () => {
        while (true) {
          const cursor = next++;
          if (cursor >= candidates.length) return;
          await verifyOne(candidates[cursor]);
        }
      }),
    );

    if (unreadable) {
      this.logger.warn(
        `Job ${jobId}: ${unreadable}/${candidates.length} question(s) could not be verified ` +
          `(provider unavailable or unreadable reply); those were kept unverified.`,
      );
    }

    return rejected;
  }

  /**
   * Checks each generated question against the whole question bank.
   *
   * The existing-questions list pasted into the prompt is capped, so comparing
   * against it only proves a question does not repeat one of those. In a bank
   * with thousands of questions on a topic, a repeat of any question outside
   * that window was invisible - the prompt never saw it and neither did the
   * batch-level comparison.
   *
   * This closes that by searching from the generated question itself rather
   * than from the topic: embed what the model actually wrote, pull its nearest
   * neighbours out of the vector store, and run the same deterministic
   * comparison used inside a batch. Searching per question is what makes the
   * whole bank reachable; searching per topic returns the same neighbourhood
   * every time regardless of what was generated.
   *
   * The vector score itself is deliberately not used as the threshold. Score
   * semantics differ between the Qdrant and OpenSearch backends, so the store
   * is used only to narrow the field and the accept/reject decision stays with
   * the token rules, which behave identically either way.
   *
   * Fails open: a vector store outage logs and returns no duplicates rather
   * than failing the job or emptying the batch.
   */
  private async findBankDuplicates(
    candidates: Array<{ q: Record<string, any>; index: number }>,
    orgId: number | undefined,
    jobId: string | number | undefined,
  ): Promise<Map<number, string>> {
    const found = new Map<number, string>();
    if (!candidates.length) return found;

    let vectors: number[][];
    try {
      vectors = await this.embeddingsService.embedMany(
        candidates.map(({ q }) => String(q.question ?? '')),
      );
    } catch (err) {
      this.logger.warn(
        `Job ${jobId}: could not embed generated questions, skipping the ` +
          `bank-wide duplicate check: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return found;
    }

    const checkOne = async (cursor: number) => {
      const { q, index } = candidates[cursor];
      const queryVector = vectors[cursor];
      if (!queryVector?.length) return;

      let neighbourTexts: string[];
      try {
        const hits = await this.vectorService.search({
          collectionName: QDRANT_QUESTIONS_COLLECTION,
          queryVector,
          limit: BANK_NEIGHBOURS,
        });
        const ids = hits
          .map((h) => Number(h.payload?.questionId ?? h.id))
          .filter((id) => Number.isFinite(id));
        if (!ids.length) return;

        // The vector store carries no orgId, so tenant scoping happens here.
        neighbourTexts = await this.questionsService.getQuestionTextsByIds(ids, orgId);
      } catch (err) {
        this.logger.warn(
          `Job ${jobId}: bank duplicate lookup failed for question ${index + 1}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return;
      }

      // Same rules as the intra-batch check, so a question cannot be judged
      // one way against a sibling and another way against the bank.
      const verdicts = findDuplicateQuestions([q], neighbourTexts);
      if (verdicts.length) {
        found.set(index, verdicts[0].reason);
        this.logger.warn(
          `[generation-rejected] job=${jobId} question=${index + 1} reason=duplicate-in-bank ` +
            `similarity=${verdicts[0].similarity.toFixed(2)} ` +
            `detail=${JSON.stringify(verdicts[0].reason)}`,
        );
      }
    };

    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(VERIFY_CONCURRENCY, candidates.length) }, async () => {
        while (true) {
          const cursor = next++;
          if (cursor >= candidates.length) return;
          await checkOne(cursor);
        }
      }),
    );

    return found;
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

    // The two lookups answer different questions and both are needed.
    //
    // Semantic neighbours cross the topic-name fragmentation in this database
    // ("Time and Distance" vs "Time And Distance", four spellings of Function
    // and Scopes) but cannot see rows written in the last few seconds, because
    // indexing runs off an outbox poller.
    //
    // The recency list is exact-match and misses variant spellings, but it is
    // the only path that sees the sibling batches of the same request. A
    // 60-question generation is six jobs of ten, so without it job six repeats
    // what job one already wrote - which is exactly how three restatements of
    // one shelf-arrangement question reached a student.
    const [similar, recent] = await Promise.all([
      this.findSimilarQuestionTexts(job, topicName, topicDescription, orgId),
      this.questionsService
        .getRecentQuestionTextsByTopic(topicName, orgId, RECENT_TOPIC_QUESTIONS)
        .catch((err) => {
          this.logger.warn(
            `Job ${job.id}: could not load recent questions for topic "${topicName}", ` +
              `continuing without them: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [] as string[];
        }),
    ]);

    // Recent first: those are the ones a sibling batch just wrote, so they
    // survive the truncation below if the combined list is long.
    const seen = new Set<string>();
    const existingTexts: string[] = [];
    for (const text of [...recent, ...(similar ?? [])]) {
      const key = String(text ?? '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      existingTexts.push(text);
      if (existingTexts.length >= MAX_EXISTING_TEXTS) break;
    }

    if (existingTexts.length > 0) {
      this.logger.log(
        `Job ${job.id}: including ${existingTexts.length} existing questions ` +
          `(${recent.length} recent, ${similar?.length ?? 0} semantic) ` +
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

    // Everything above this point is a contract with the model: it was asked
    // for N questions at given difficulties in a given shape, and a breach
    // means the whole batch is suspect and the job retries.
    //
    // Everything below is quality filtering of a batch that honoured the
    // contract. Individual questions are dropped here, and the job succeeds
    // with fewer rows than requested. That trade is deliberate: a short batch
    // is a gap a regeneration fills, whereas a wrongly keyed question marks a
    // student's correct answer wrong and then generates an explanation
    // defending the wrong option, because the explainer treats the stored
    // answer as ground truth by design.
    const dropped = new Map<number, string>();

    findDuplicateQuestions(
      evaluations as Array<Record<string, any>>,
      existingTexts,
    ).forEach((d) => {
      dropped.set(d.index, `duplicate (similarity ${d.similarity.toFixed(2)}): ${d.reason}`);
      this.logger.warn(
        `[generation-rejected] job=${job.id} question=${d.index + 1} reason=duplicate ` +
          `similarity=${d.similarity.toFixed(2)} detail=${JSON.stringify(d.reason)}`,
      );
    });

    const survivors = () =>
      evaluations
        .map((q, index) => ({ q: q as Record<string, any>, index }))
        .filter(({ index }) => !dropped.has(index));

    // Against the whole bank, not just the questions shown to the model.
    // Runs before verification so a repeat is dropped without paying for a
    // second opinion on it.
    const bankDuplicates = await this.findBankDuplicates(survivors(), orgId, job.id);
    bankDuplicates.forEach((reason, index) => {
      dropped.set(index, `duplicate in bank: ${reason}`);
    });

    if (VERIFY_GENERATED_ANSWERS) {
      // Returns original batch indices, so the log lines and this map agree
      // on which question is which.
      const rejected = await this.verifyKeyedAnswers(survivors(), job.id);
      rejected.forEach((index) => {
        dropped.set(index, 'answer verification');
      });
    }

    const accepted = evaluations.filter((_, index) => !dropped.has(index));

    if (dropped.size > 0) {
      this.logger.warn(
        `Job ${job.id}: dropped ${dropped.size}/${evaluations.length} generated question(s) ` +
          `for topic "${topicName}"; storing ${accepted.length}. ` +
          `See the [generation-rejected] lines above for the reason on each.`,
      );
    }

    if (accepted.length === 0) {
      // Not a retry: the model produced a well-formed batch and every item
      // failed on merit. Retrying re-runs the same prompt against the same
      // pool and burns the attempt budget for the same outcome.
      this.logger.error(
        `Job ${job.id}: every generated question for topic "${topicName}" was rejected ` +
          `(${dropped.size} of ${evaluations.length}). Storing none.`,
      );
      return;
    }

    const requestedByUserId = job.data.requestedByUserId;
    const inserted = await this.questionsService.createManyWithOutbox(
      accepted.map((q) => {
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
