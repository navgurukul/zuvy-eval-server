/**
 * Cheap, deterministic near-duplicate detection for generated MCQs.
 *
 * A 60-question request is six independent jobs of ten, so duplicates arise in
 * two places and both need catching:
 *
 *   - inside one batch, where nothing checked at all;
 *   - across sibling batches, which cannot see each other's rows until they
 *     are inserted and indexed.
 *
 * The shape being caught is a stem restated with the wording varied and the
 * same option set shuffled into a new order - what a model produces when asked
 * twice for a question on the same narrow concept. Option order is therefore
 * discarded before comparing, or a shuffle alone would hide the repeat.
 *
 * Embeddings would also catch it, but they cost a network round trip per
 * question and fail open when the vector store is down. Token overlap is free,
 * synchronous and good enough for restatements of one stem, which is the
 * actual problem. Semantic retrieval still runs over the existing bank; this
 * is the check that cannot fail open.
 *
 * Tuning note: every rule here is a similarity threshold over token sets, with
 * no knowledge of any particular topic or question. The thresholds are
 * exported so they can be moved from one place.
 */

/**
 * Words carrying no topic signal. Kept deliberately small: every word removed
 * here raises the similarity of unrelated questions, so this covers question
 * scaffolding ("in how many ways can ...") and nothing else. Numbers are NOT
 * stopwords - "3 books" vs "5 books" are different questions and the digits
 * are the only thing distinguishing them.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'if',
  'in',
  'is',
  'it',
  'its',
  'many',
  'much',
  'of',
  'on',
  'or',
  'that',
  'the',
  'then',
  'there',
  'these',
  'this',
  'to',
  'was',
  'way',
  'ways',
  'were',
  'what',
  'when',
  'which',
  'will',
  'with',
]);

/** Similarity at or above which two stems are the same question restated. */
export const DUPLICATE_STEM_THRESHOLD = 0.82;

/**
 * Lower bar applied only when two questions also offer the identical set of
 * options. Four matching distractors plus a half-matching stem is not a
 * coincidence, and this is the rule that catches a stem reworded more heavily
 * than the threshold above allows.
 */
export const DUPLICATE_WITH_SAME_OPTIONS_THRESHOLD = 0.5;

/** Lowercase, strip punctuation, drop scaffolding words. Order is discarded. */
export function questionTokenSet(text: string): Set<string> {
  const words = String(text ?? '')
    .toLowerCase()
    // Keep digits and letters; hyphens and slashes become boundaries so
    // "5-letter" splits into "5" and "letter".
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * The numbers appearing in a question.
 *
 * These are the strongest discriminator between two otherwise identical stems
 * ("...4 runners..." vs "...6 runners...") and, unlike the stopword list
 * above, digits carry no language. That matters: questions here have a
 * language field, the stopword list is English, and in any other language
 * nothing gets stripped, every question keeps its scaffolding words, and
 * similarity scores inflate across the board. Without this rule a Hindi pair
 * differing only in a quantity could clear the threshold and one would be
 * dropped as a duplicate of the other.
 */
export function numericTokens(tokens: Set<string>): Set<string> {
  const numbers = new Set<string>();
  tokens.forEach((token) => {
    if (/^\d+$/.test(token)) numbers.add(token);
  });
  return numbers;
}

/**
 * True when two questions pose the same quantities.
 *
 * Two questions with different numbers in them are different questions,
 * whatever their wording overlap, so this gates every duplicate rule below
 * rather than feeding into a score that a high enough overlap could outvote.
 * Questions with no numbers at all compare equal here and fall through to
 * being judged on wording alone.
 */
export function sameNumbers(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  // forEach rather than for...of: iterating a Set directly needs
  // downlevelIteration unless the target is ES2015+, and a spec file excluded
  // from a tsconfig gets compiled with default options where it is not.
  let same = true;
  a.forEach((n) => {
    if (!b.has(n)) same = false;
  });
  return same;
}

/** |A n B| / |A u B|. Returns 0 when either side is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((token) => {
    if (b.has(token)) intersection += 1;
  });
  return intersection / (a.size + b.size - intersection);
}

/**
 * Order-independent fingerprint of an option set, so the same four answers
 * shuffled into a different order produce the same string.
 */
export function optionSetKey(
  options: Record<string, string> | undefined,
): string {
  if (!options || typeof options !== 'object') return '';
  const texts = Object.values(options)
    .map((t) =>
      String(t ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' '),
    )
    .filter(Boolean)
    .sort();
  return texts.length ? texts.join('|') : '';
}

export type DuplicateVerdict = {
  /** Index into the batch of the question being dropped. */
  index: number;
  similarity: number;
  /** Human-readable account of what it collided with, for the log line. */
  reason: string;
};

/**
 * Decides which generated questions to drop.
 *
 * Compares each question against the questions already accepted from this
 * batch and against the existing-question texts that were shown to the model
 * as "do not repeat these". The first occurrence of a duplicated stem is kept
 * and every later one dropped, so a batch never loses both copies.
 *
 * Existing questions carry no options here (the prompt only ever received
 * their text), so the identical-option-set rule applies within the batch only.
 */
export function findDuplicateQuestions(
  evaluations: Array<Record<string, any>>,
  existingTexts: string[] = [],
): DuplicateVerdict[] {
  const describe = (text: string) => {
    const tokens = questionTokenSet(text);
    return { text, tokens, numbers: numericTokens(tokens) };
  };

  const existing = existingTexts
    .filter((t) => t && String(t).trim())
    .map((t) => describe(String(t)));

  const kept: Array<ReturnType<typeof describe> & { optionKey: string }> = [];
  const duplicates: DuplicateVerdict[] = [];

  evaluations.forEach((q, index) => {
    const text = String(q?.question ?? '');
    const self = describe(text);
    const optionKey = optionSetKey(
      q?.options as Record<string, string> | undefined,
    );

    if (!self.tokens.size) {
      // Nothing to compare. Structural validation owns empty questions.
      kept.push({ ...self, optionKey });
      return;
    }

    let worst: DuplicateVerdict | null = null;

    const consider = (similarity: number, reason: string) => {
      if (!worst || similarity > worst.similarity) {
        worst = { index, similarity, reason };
      }
    };

    for (const prior of kept) {
      // Different quantities mean a different question, however close the
      // wording. Checked before the score so no amount of shared phrasing
      // can outvote it.
      if (!sameNumbers(self.numbers, prior.numbers)) continue;

      const similarity = jaccard(self.tokens, prior.tokens);
      const sameOptions = Boolean(optionKey) && optionKey === prior.optionKey;

      if (similarity >= DUPLICATE_STEM_THRESHOLD) {
        consider(
          similarity,
          `restates an earlier question in this batch: "${truncate(prior.text)}"`,
        );
      } else if (
        sameOptions &&
        similarity >= DUPLICATE_WITH_SAME_OPTIONS_THRESHOLD
      ) {
        consider(
          similarity,
          `shares an identical option set with an earlier question in this batch: "${truncate(prior.text)}"`,
        );
      }
    }

    for (const prior of existing) {
      if (!sameNumbers(self.numbers, prior.numbers)) continue;

      const similarity = jaccard(self.tokens, prior.tokens);
      if (similarity >= DUPLICATE_STEM_THRESHOLD) {
        consider(
          similarity,
          `restates a question already in the bank: "${truncate(prior.text)}"`,
        );
      }
    }

    if (worst) {
      duplicates.push(worst);
    } else {
      kept.push({ ...self, optionKey });
    }
  });

  return duplicates;
}

function truncate(text: string, max = 80): string {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}
