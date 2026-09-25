import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  generateMcqPromptFromSpec,
  parseVerifierVerdict,
  verifyMcqAnswerPrompt,
} from 'src/ai-assessment/system_prompts/system_prompts';
import {
  GenerationRefusedError,
  parseLlmMcq,
} from 'src/llm/llm_response_parsers/mcqParser';
import { LlmService } from 'src/llm/llm.service';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { VectorService } from 'src/vector/vector.service';
import { GenerateTopicBatchJobPayload } from './dto/generate-questions.dto';
import { QuestionsService } from './questions.service';
import { shuffleMcqOptionOrder } from './mcq-option-shuffle.util';
import {
  describeQuestionText,
  findDuplicateQuestions,
  findTemplateRepeats,
  isSemanticDuplicate,
} from './question-similarity.util';

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
  String(process.env.VERIFY_GENERATED_ANSWERS ?? 'true').toLowerCase() !==
  'false';

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

/**
 * Whether a disagreement gets a third opinion before the question is dropped.
 *
 * On by default, and it is the difference between losing a question to a
 * genuine error and losing it to a careless check. A disagreement means one of
 * the two is wrong, not which, and the dissent has been measured wrong often
 * enough that acting on it alone is not safe: on one combination batch the
 * verifier answered 84 where the answer was 105, and gave the unconstrained
 * total for a question that named a required element.
 *
 * Costs one extra call per disagreement and nothing on the questions that
 * agree, so it is paid only where it changes an outcome.
 */
const TIEBREAK_ON_DISAGREEMENT =
  String(process.env.TIEBREAK_ON_DISAGREEMENT ?? 'true').toLowerCase() !==
  'false';

/**
 * How many times a job may regenerate to replace questions it dropped.
 *
 * A request for 60 questions must store 60, so a job that drops 3 asks for 3
 * more rather than storing 57. Rounds are bounded because the shortfall is not
 * guaranteed to shrink: a topic narrow enough that every new question repeats
 * an existing one would otherwise regenerate forever.
 *
 * Five is generous for the observed drop rate. A ten-question round losing two
 * needs one top-up of two, and that top-up would have to fail almost entirely
 * for a third round to be needed.
 */
const MAX_GENERATION_ROUNDS = Math.max(
  1,
  Number(process.env.MAX_GENERATION_ROUNDS ?? 5) || 5,
);

type DifficultyCounts = { easy: number; medium: number; hard: number };

const DIFFICULTIES: Array<keyof DifficultyCounts> = ['easy', 'medium', 'hard'];

/** Null when no difficulty split was requested, so callers can skip the checks. */
function normalizeDifficultyCounts(
  source: { easy?: number; medium?: number; hard?: number } | undefined,
): DifficultyCounts | null {
  if (!source) return null;
  const counts: DifficultyCounts = {
    easy: source.easy ?? 0,
    medium: source.medium ?? 0,
    hard: source.hard ?? 0,
  };
  return counts.easy + counts.medium + counts.hard > 0 ? counts : null;
}

function countByDifficulty(
  items: Array<Record<string, any>>,
): DifficultyCounts {
  const counts: DifficultyCounts = { easy: 0, medium: 0, hard: 0 };
  items.forEach((q) => {
    const difficulty = String(q.difficulty ?? '')
      .trim()
      .toLowerCase() as keyof DifficultyCounts;
    if (DIFFICULTIES.includes(difficulty)) counts[difficulty] += 1;
  });
  return counts;
}

/**
 * What is still owed per difficulty.
 *
 * Replacing a dropped hard question with a hard question is the whole point:
 * asking only for "3 more" lets the model return three easy ones and quietly
 * change the shape of the assessment.
 */
function subtractDifficultyCounts(
  target: DifficultyCounts,
  have: DifficultyCounts,
): DifficultyCounts {
  return {
    easy: Math.max(0, target.easy - have.easy),
    medium: Math.max(0, target.medium - have.medium),
    hard: Math.max(0, target.hard - have.hard),
  };
}

/**
 * Takes as much of a generated batch as was actually asked for.
 *
 * Models miscount. Asked for ten they return eleven, or nine, or ten with the
 * difficulty mix a little off. None of that is worth failing a job over now
 * that the caller regenerates shortfalls: an extra question is dropped, a
 * missing one is requested again next round.
 *
 * With difficulty counts, questions are taken per difficulty until each is
 * satisfied, so the mix survives the trim - taking the first N by position
 * would let an over-long batch silently reshape it. Without counts, order is
 * all there is to go on.
 */
function selectToCounts(
  evaluations: Array<Record<string, any>>,
  need: number,
  needCounts: DifficultyCounts | null,
): Array<Record<string, any>> {
  if (!needCounts) return evaluations.slice(0, need);

  const remaining: DifficultyCounts = { ...needCounts };
  const picked: Array<Record<string, any>> = [];

  evaluations.forEach((q) => {
    const difficulty = String(q.difficulty ?? '')
      .trim()
      .toLowerCase() as keyof DifficultyCounts;
    if (DIFFICULTIES.includes(difficulty) && remaining[difficulty] > 0) {
      remaining[difficulty] -= 1;
      picked.push(q);
    }
  });

  return picked;
}

/**
 * Whether there is enough topic context to judge a question's relevance by.
 *
 * Topic names in this database are not reliably meaningful: alongside real
 * names there are numeric ones like "115" and several spellings of the same
 * subject. Asking a model "is this question about 115?" gets a confident no
 * for every question, which would drop an entire batch and fail the job.
 *
 * So relevance is only reviewed when the topic says something a reader could
 * act on: a name with letters in it, or a description or subtopics to fall
 * back on. Otherwise the review fields are not requested at all and the
 * verifier does only what it did before.
 */
export function reviewableTopic(
  name: string,
  description: string,
  subtopics: string[] | undefined,
): { name: string; description?: string; subtopics?: string[] } | null {
  const trimmedName = String(name ?? '').trim();
  const trimmedDescription = String(description ?? '').trim();
  const cleanSubtopics = (subtopics ?? [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);

  const nameIsMeaningful = /[a-z]{3}/i.test(trimmedName);
  if (!nameIsMeaningful && !trimmedDescription && !cleanSubtopics.length) {
    return null;
  }

  return {
    name: trimmedName || '(unnamed)',
    description: trimmedDescription || undefined,
    subtopics: cleanSubtopics.length ? cleanSubtopics : undefined,
  };
}

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

  override async process(
    job: Job<GenerateTopicBatchJobPayload, void, string>,
    token?: string,
  ): Promise<void> {
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
      if (
        keys.length !== OPTION_KEYS.length ||
        !OPTION_KEYS.every((k) => k in options)
      ) {
        problems.push(
          `${where}: options keys are [${keys.join(', ')}], expected 1-4`,
        );
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
      if (
        !Number.isInteger(correct) ||
        !OPTION_KEYS.includes(String(correct))
      ) {
        problems.push(
          `${where}: correctOption is ${q.correctOption}, expected 1-4`,
        );
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
  /**
   * One more independent solve of the same question, for breaking a tie.
   *
   * Deliberately the same prompt and the same provider order as the first
   * check. What makes it a second opinion is that it is a separate sample, not
   * a different instruction: a re-solve lands on the same answer when the
   * question is clear and diverges when it is not, which is the signal worth
   * having. Returns null when it could not be read, so an outage leaves the
   * original verdict standing rather than silently rescuing every question.
   */
  private async solveIndependently(
    prompt: string,
    index: number,
    jobId: string | number | undefined,
  ): Promise<ReturnType<typeof parseVerifierVerdict>> {
    try {
      const response = await this.llmService.generateCompletionPreferring(
        VERIFIER_PROVIDER,
        prompt,
      );
      return parseVerifierVerdict(response?.text);
    } catch (err) {
      this.logger.warn(
        `Job ${jobId}: tie-break call failed for question ${index + 1}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }

  private async verifyKeyedAnswers(
    candidates: Array<{ q: Record<string, any>; index: number }>,
    jobId: string | number | undefined,
    topic?: { name: string; description?: string; subtopics?: string[] } | null,
  ): Promise<Set<number>> {
    const rejected = new Set<number>();
    if (!candidates.length) return rejected;

    let unreadable = 0;
    let difficultyMismatches = 0;

    const verifyOne = async ({
      q,
      index,
    }: {
      q: Record<string, any>;
      index: number;
    }) => {
      const prompt = verifyMcqAnswerPrompt({
        question: String(q.question ?? ''),
        options: q.options as Record<string, string>,
        topic: topic ?? undefined,
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

      if (verdict.correctOption !== keyed) {
        // Two sources disagree and neither is reliable enough to decide alone,
        // so ask a third and let the majority settle it.
        //
        // Deciding on one dissent was costing good questions. Checked by hand
        // against a combination batch, the verifier was the one in the wrong
        // on several: it answered 84 where C(9,4) - C(7,2) = 105, and returned
        // C(12,5) in full for a question that required a particular book, the
        // constraint dropped entirely. Every one of those took a sound
        // question out of the batch.
        //
        // The generator's key is the first vote, this verdict the second. A
        // third solve breaks the tie:
        //
        //   third agrees with the key      -> keep, the verifier was the odd
        //                                     one out
        //   third agrees with the verifier -> drop, two independent solves
        //                                     say the key is wrong
        //   third says something else      -> drop, nobody agrees and the
        //                                     question cannot be trusted
        //
        // Only disagreements pay for the extra call, and dropping still never
        // re-keys a question: a majority is enough to distrust a stored answer
        // and not enough to overwrite one.
        const second = TIEBREAK_ON_DISAGREEMENT
          ? await this.solveIndependently(prompt, index, jobId)
          : null;

        const describeVerdict = (v: typeof verdict) =>
          v?.correctOption === null ? 'none' : String(v?.correctOption ?? '?');

        if (second && second.correctOption === keyed) {
          this.logger.log(
            `Job ${jobId}: question ${index + 1} kept on a tie-break; the first check said ` +
              `${describeVerdict(verdict)} and a second solve agreed with the stored answer ` +
              `${keyed}.`,
          );
        } else {
          rejected.add(index);
          const reason =
            verdict.correctOption === null
              ? 'no-correct-option'
              : 'answer-disagreement';
          this.logger.warn(
            `[generation-rejected] job=${jobId} question=${index + 1} reason=${reason} ` +
              `keyed=${keyed} verifier=${describeVerdict(verdict)} ` +
              `tiebreak=${second ? describeVerdict(second) : 'unavailable'} ` +
              `verifierAnswer=${JSON.stringify(verdict.computedAnswer)} ` +
              `question=${JSON.stringify(String(q.question ?? '').slice(0, 120))}`,
          );
          return;
        }
      }

      // A question about a different subject than the one requested is a
      // defect the same way a wrong answer is: the assessment stops measuring
      // what it claims to. Only an explicit false drops it, so a model that
      // omits the field leaves the question alone.
      if (verdict.onTopic === false) {
        rejected.add(index);
        this.logger.warn(
          `[generation-rejected] job=${jobId} question=${index + 1} reason=off-topic ` +
            `topic=${JSON.stringify(topic?.name ?? '')} ` +
            `question=${JSON.stringify(String(q.question ?? '').slice(0, 120))}`,
        );
        return;
      }

      // Difficulty is counted, never enforced, and deliberately not logged per
      // question.
      //
      // A model that has just solved a question finds it easy, so it calls
      // almost everything easy: a real statistics batch had seven of ten
      // medium and hard questions reported as easy, one warning each. That is
      // noise, and noise in a log is worse than silence because it buries the
      // rejection lines that do need acting on. One count per batch says the
      // same thing and stays readable.
      const labelled = String(q.difficulty ?? '')
        .trim()
        .toLowerCase();
      if (verdict.difficulty && labelled && verdict.difficulty !== labelled) {
        difficultyMismatches += 1;
      }
    };

    // Fixed-size pool rather than Promise.all over the whole batch, so a
    // larger batch size later cannot turn into a burst of parallel calls.
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(VERIFY_CONCURRENCY, candidates.length) },
        async () => {
          while (true) {
            const cursor = next++;
            if (cursor >= candidates.length) return;
            await verifyOne(candidates[cursor]);
          }
        },
      ),
    );

    if (unreadable) {
      this.logger.warn(
        `Job ${jobId}: ${unreadable}/${candidates.length} question(s) could not be verified ` +
          `(provider unavailable or unreadable reply); those were kept unverified.`,
      );
    }

    if (difficultyMismatches) {
      this.logger.log(
        `Job ${jobId}: the reviewer would have labelled ` +
          `${difficultyMismatches}/${candidates.length} question(s) at a different difficulty. ` +
          `Recorded only; the generator's label is what is stored.`,
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
        neighbourTexts = await this.questionsService.getQuestionTextsByIds(
          ids,
          orgId,
        );
      } catch (err) {
        this.logger.warn(
          `Job ${jobId}: bank duplicate lookup failed for question ${index + 1}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return;
      }

      // Wording first: free, and it catches the obvious restatements.
      const verdicts = findDuplicateQuestions([q], neighbourTexts);
      if (verdicts.length) {
        found.set(index, verdicts[0].reason);
        this.logger.warn(
          `[generation-rejected] job=${jobId} question=${index + 1} reason=duplicate-in-bank ` +
            `similarity=${verdicts[0].similarity.toFixed(2)} ` +
            `detail=${JSON.stringify(verdicts[0].reason)}`,
        );
        return;
      }

      // Then meaning, which is what catches a paraphrase sharing no wording -
      // the case that dominates on conceptual topics. Embedding the
      // neighbours costs one more call per question and is the only way to
      // compare them like for like: the store's own score is not comparable
      // across the Qdrant and OpenSearch backends, so the decision cannot be
      // built on it.
      if (!neighbourTexts.length) return;

      let neighbourVectors: number[][];
      try {
        neighbourVectors =
          await this.embeddingsService.embedMany(neighbourTexts);
      } catch (err) {
        this.logger.warn(
          `Job ${jobId}: could not embed bank neighbours for question ${index + 1}, ` +
            `wording check only: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return;
      }

      const self = describeQuestionText(String(q.question ?? ''));
      for (let i = 0; i < neighbourTexts.length; i++) {
        const similarity = isSemanticDuplicate(
          self,
          describeQuestionText(neighbourTexts[i]),
          queryVector,
          neighbourVectors[i] ?? [],
        );
        if (similarity === null) continue;

        const reason =
          `means the same as a question already in the bank: ` +
          `"${neighbourTexts[i].slice(0, 80)}"`;
        found.set(index, reason);
        this.logger.warn(
          `[generation-rejected] job=${jobId} question=${index + 1} reason=paraphrase-in-bank ` +
            `cosine=${similarity.toFixed(3)} detail=${JSON.stringify(reason)}`,
        );
        return;
      }
    };

    // Paraphrases of each other inside this one batch, before any of them are
    // compared with the bank. The vectors are already in hand, so this costs
    // nothing, and it closes the same gap the token rules leave: two questions
    // generated seconds apart phrased entirely differently.
    //
    // The earlier of any pair is kept, matching findDuplicateQuestions, so a
    // batch never loses both copies of a question.
    for (let i = 0; i < candidates.length; i++) {
      if (found.has(candidates[i].index)) continue;
      const a = describeQuestionText(String(candidates[i].q.question ?? ''));

      for (let j = i + 1; j < candidates.length; j++) {
        if (found.has(candidates[j].index)) continue;
        const b = describeQuestionText(String(candidates[j].q.question ?? ''));

        const similarity = isSemanticDuplicate(
          a,
          b,
          vectors[i] ?? [],
          vectors[j] ?? [],
        );
        if (similarity === null) continue;

        const reason = `means the same as an earlier question in this batch: "${a.text.slice(0, 80)}"`;
        found.set(candidates[j].index, reason);
        this.logger.warn(
          `[generation-rejected] job=${jobId} question=${candidates[j].index + 1} ` +
            `reason=paraphrase-in-batch cosine=${similarity.toFixed(3)} ` +
            `detail=${JSON.stringify(reason)}`,
        );
      }
    }

    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(VERIFY_CONCURRENCY, candidates.length) },
        async () => {
          while (true) {
            const cursor = next++;
            if (cursor >= candidates.length) return;
            if (found.has(candidates[cursor].index)) continue;
            await checkOne(cursor);
          }
        },
      ),
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

  /**
   * One generate-and-filter pass. Returns only the questions worth storing.
   *
   * The checks fall into two kinds and they fail differently:
   *
   *   - Contract breaches (unparseable reply, wrong batch size, wrong
   *     difficulty mix) throw. The model was asked for something specific and
   *     did not deliver it, so the whole round is suspect.
   *   - Quality failures (duplicate, disagreed answer) drop one question and
   *     return the rest. The caller regenerates the difference.
   */
  private async generateFilteredRound(
    job: Job<GenerateTopicBatchJobPayload, void, string>,
    ctx: {
      topicName: string;
      topicDescription: string;
      orgId: number | undefined;
    },
    need: number,
    needCounts: DifficultyCounts | null,
    /**
     * Last chance to reach the count, so preferences give way to it.
     *
     * Variety and the difficulty mix are both things worth having and neither
     * is worth returning a short batch for. Holding out for them on the final
     * round spends it and ends with fewer questions than asked for, which is
     * the outcome both were meant to improve on.
     */
    relaxPreferences: boolean,
    avoidTexts: string[],
  ): Promise<Array<Record<string, any>>> {
    const { topicName, topicDescription, orgId } = ctx;

    const prompt = generateMcqPromptFromSpec(
      {
        ...job.data,
        topic: topicName,
        topicName,
        topicDescription,
        count: need,
        batchQuestionCounts: needCounts ?? undefined,
      },
      avoidTexts.slice(0, MAX_EXISTING_TEXTS),
    );

    const aiResponse = await this.llmService.generateCompletion(prompt);
    if (!aiResponse?.text) {
      throw new Error(
        'LLM returned no response (rate limit or provider down). Job will retry with backoff.',
      );
    }

    let evaluations: Array<Record<string, any>>;
    try {
      const parsed = await parseLlmMcq(aiResponse.text);
      evaluations = (parsed.evaluations ?? []) as Array<Record<string, any>>;
    } catch (err) {
      if (err instanceof GenerationRefusedError) {
        // A refusal is information, not a fault: the topic has run out of
        // questions it can write that are not repeats of the do-not-repeat
        // list. Returning nothing lets the caller decide, rather than killing
        // a job that may already hold most of its batch.
        this.logger.warn(
          `Job ${job.id}: model declined to generate ${need} more question(s) for topic ` +
            `"${topicName}": ${err.reason}`,
        );
        return [];
      }
      throw err;
    }
    this.assertWellFormedMcqs(evaluations, job.id);

    if (!evaluations.length) {
      // Nothing usable came back at all. Unlike a miscount, there is nothing to
      // salvage and nothing for the caller to top up, so the job retries.
      throw new Error(
        `No questions returned for job ${job.id}; the reply parsed but was empty.`,
      );
    }

    // A miscount is not a failure any more.
    //
    // This used to throw, which cost the whole job: a batch of ten coming back
    // as eleven burned a BullMQ attempt and an exponential backoff, and a real
    // job spent four attempts and about two minutes on a single extra
    // question. The top-up loop that now wraps this round makes that pointless
    // - too few is exactly what it exists to fix, and too many only needs
    // trimming.
    //
    // Selection is by difficulty rather than by position, so trimming an
    // over-long batch cannot quietly change the easy/medium/hard mix that was
    // asked for.
    const selected = selectToCounts(evaluations, need, needCounts);

    if (selected.length !== evaluations.length) {
      this.logger.log(
        `Job ${job.id}: model returned ${evaluations.length} question(s) for a request of ` +
          `${need}; keeping ${selected.length} that fit the requested difficulty mix.`,
      );
    }

    const dropped = new Map<number, string>();

    findDuplicateQuestions(selected, avoidTexts).forEach((d) => {
      dropped.set(
        d.index,
        `duplicate (similarity ${d.similarity.toFixed(2)}): ${d.reason}`,
      );
      this.logger.warn(
        `[generation-rejected] job=${job.id} question=${d.index + 1} reason=duplicate ` +
          `similarity=${d.similarity.toFixed(2)} detail=${JSON.stringify(d.reason)}`,
      );
    });

    // Variety, which is a different question from duplication. A batch can
    // contain no repeats and still practise one exercise seven times with the
    // numbers changed; the numeric guard that keeps "arrange 3 books" apart
    // from "arrange 5 books" is exactly what lets that through.
    //
    // Skipped on the final round. A narrow topic has genuinely few exercises,
    // so enforcing variety to the end guarantees a short batch on exactly the
    // topics where the count is hardest to reach. Every earlier round pushes
    // for variety; the last one takes what it can get.
    const templateRepeats = relaxPreferences
      ? []
      : findTemplateRepeats(selected, avoidTexts);

    templateRepeats.forEach((t) => {
      dropped.set(t.index, `template repeat: ${t.reason}`);
      this.logger.warn(
        `[generation-rejected] job=${job.id} question=${t.index + 1} reason=template-repeat ` +
          `similarity=${t.similarity.toFixed(2)} detail=${JSON.stringify(t.reason)}`,
      );
    });

    const survivors = () =>
      selected
        .map((q, index) => ({ q, index }))
        .filter(({ index }) => !dropped.has(index));

    // Against the whole bank, not just the questions shown to the model.
    // Runs before verification so a repeat is dropped without paying for a
    // second opinion on it.
    const bankDuplicates = await this.findBankDuplicates(
      survivors(),
      orgId,
      job.id,
    );
    bankDuplicates.forEach((reason, index) => {
      dropped.set(index, `duplicate in bank: ${reason}`);
    });

    if (VERIFY_GENERATED_ANSWERS) {
      // Returns original indices within this round, so the log lines and this
      // map agree on which question is which.
      const rejected = await this.verifyKeyedAnswers(
        survivors(),
        job.id,
        reviewableTopic(topicName, topicDescription, job.data.subtopics),
      );
      rejected.forEach((index) => {
        dropped.set(index, 'answer verification');
      });
    }

    if (dropped.size > 0) {
      this.logger.warn(
        `Job ${job.id}: dropped ${dropped.size}/${selected.length} generated question(s) ` +
          `for topic "${topicName}". See the [generation-rejected] lines above for each reason.`,
      );
    }

    return selected.filter((_, index) => !dropped.has(index));
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
          .getRecentQuestionTextsByTopic(
            topicName,
            orgId,
            RECENT_TOPIC_QUESTIONS,
          )
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
        const key = String(text ?? '')
          .trim()
          .toLowerCase();
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

      // A job stores exactly the count it was asked for. Quality filtering drops
      // individual questions, so the shortfall is regenerated rather than
      // delivered short: asking for 60 and storing 57 is not an answer.
      //
      // Each round requests only the deficit, and the deficit per difficulty, so
      // a dropped hard question is replaced by a hard one. Questions accepted so
      // far are carried into the next round's "do not repeat" list, so a top-up
      // cannot restate what it is topping up.
      const targetCounts = normalizeDifficultyCounts(
        job.data.batchQuestionCounts,
      );
      const accepted: Array<Record<string, any>> = [];
      const avoidTexts = [...existingTexts];
      let roundsUsed = 0;

      for (let round = 1; round <= MAX_GENERATION_ROUNDS; round++) {
        const need = count - accepted.length;
        if (need <= 0) break;
        roundsUsed = round;

        // On the last allowed round, stop asking for a difficulty mix.
        //
        // The count is the promise; the mix is a preference. A model that
        // keeps returning five medium where four were asked for will do it
        // again, so holding out for the exact mix spends the last round and
        // ends with the whole batch failing - which is how a request for 30
        // questions came back with 20. Better a batch of 30 whose mix is a
        // little off than 20 with a perfect one.
        const lastRound = round === MAX_GENERATION_ROUNDS;
        const needCounts =
          targetCounts && !lastRound
            ? subtractDifficultyCounts(
                targetCounts,
                countByDifficulty(accepted),
              )
            : null;

        if (lastRound && need > 0) {
          this.logger.warn(
            `Job ${job.id}: final round for topic "${topicName}"; asking for the remaining ` +
              `${need} question(s) with the difficulty mix and variety checks relaxed so the ` +
              `batch reaches ${count}. Some may repeat an exercise already covered, or sit at ` +
              `a different difficulty than requested.`,
          );
        } else if (round > 1) {
          this.logger.log(
            `Job ${job.id}: round ${round}, regenerating ${need} question(s) to reach ${count}` +
              (needCounts
                ? ` (easy=${needCounts.easy}, medium=${needCounts.medium}, hard=${needCounts.hard})`
                : ''),
          );
        }

        const roundAccepted = await this.generateFilteredRound(
          job,
          { topicName, topicDescription, orgId },
          need,
          needCounts,
          lastRound,
          avoidTexts,
        );

        roundAccepted.forEach((q) => {
          accepted.push(q);
          // Front of the list: a question written seconds ago is the one the
          // next round is most likely to restate, and the list gets truncated.
          avoidTexts.unshift(String(q.question ?? ''));
        });
      }

      if (accepted.length === 0) {
        // Nothing survived, so there is nothing to keep and a retry is the only
        // way forward. A fresh prompt may do better; storing zero and calling
        // it done would not.
        throw new Error(
          `Job ${job.id}: produced no usable questions for topic "${topicName}" after ` +
            `${roundsUsed} round(s); every one was dropped as a duplicate or failed answer ` +
            `verification. Job will retry.`,
        );
      }

      if (accepted.length < count) {
        // Short, but keep what passed.
        //
        // This used to throw, on the reasoning that an exact count was the
        // promise. In practice it cost far more than it protected: a job one
        // question short discarded the other nine, then BullMQ retried it five
        // times with exponential backoff, regenerating and re-verifying work
        // that was already good. A request for 30 came back as 20 - not
        // because ten questions were bad, but because one was missing.
        //
        // The rule existed to stop a partial write plus a retry from storing
        // the same questions twice. Succeeding rather than throwing removes
        // the retry, so that risk goes away instead of being traded off.
        //
        // Logged at error level because it is not routine: it means the topic
        // could not yield the questions asked for, and the shortfall is real
        // and needs someone to notice.
        this.logger.error(
          `Job ${job.id}: storing ${accepted.length} of the ${count} question(s) requested for ` +
            `topic "${topicName}" after ${roundsUsed} round(s). The rest were dropped as ` +
            `duplicates or failed answer verification, and regenerating produced no more. ` +
            `Generate again for this topic if the full count is needed.`,
        );
      }

      if (roundsUsed > 1) {
        this.logger.log(
          `Job ${job.id}: reached the full ${count} question(s) for topic "${topicName}" ` +
            `in ${roundsUsed} rounds.`,
        );
      }

      const requestedByUserId = job.data.requestedByUserId;
      const inserted = await this.questionsService.createManyWithOutbox(
        accepted.map((q) => {
          const rawLevel = (q as any).level;
          const normalizedLevel =
            typeof rawLevel === 'string' ? rawLevel.trim().toUpperCase() : null;
          const allowedBands = ['A+', 'A', 'B', 'C', 'D', 'E'] as const;
          const levelBand: (typeof allowedBands)[number] | null =
            normalizedLevel &&
            (allowedBands as readonly string[]).includes(normalizedLevel)
              ? (normalizedLevel as (typeof allowedBands)[number])
              : levelId &&
                  (allowedBands as readonly string[]).includes(
                    String(levelId).toUpperCase(),
                  )
                ? (String(
                    levelId,
                  ).toUpperCase() as (typeof allowedBands)[number])
                : null;

          const {
            options: shuffledOptions,
            correctOption: shuffledCorrectOption,
          } = shuffleMcqOptionOrder(
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
