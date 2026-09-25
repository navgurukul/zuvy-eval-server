import {
  DUPLICATE_STEM_THRESHOLD,
  cosineSimilarity,
  describeQuestionText,
  findDuplicateQuestions,
  isSemanticDuplicate,
  jaccard,
  numericTokens,
  optionSetKey,
  questionTokenSet,
  sameNumbers,
} from './question-similarity.util';

/**
 * The detector sees tokens, never meaning: it has no notion of a topic, a
 * subject or a language. So the inputs here are nonsense words assembled by
 * the helpers below, not questions.
 *
 * That is the point of writing them this way. Real sentences would invite the
 * reader to believe some property holds because of what the words mean; these
 * can only pass because of the rule under test. Anything that works on
 * "wug lorp blint" works on any topic anyone ever generates for.
 */

/** Nonsense content words. No stopword list in any language contains these. */
const W = ['wug', 'lorp', 'blint', 'praxil', 'doved', 'skarn', 'velm', 'tarn'];

/** A stem of `n` content words, optionally carrying a number. */
const stem = (n: number, quantity?: number): string =>
  [...W.slice(0, n), quantity === undefined ? '' : String(quantity)]
    .filter(Boolean)
    .join(' ');

/** The same stem with one word swapped: a restatement, not a new question. */
const reworded = (n: number, quantity?: number): string =>
  stem(n, quantity).replace(W[0], 'in how many ways');

const options = (...texts: string[]): Record<string, string> =>
  Object.fromEntries(texts.map((t, i) => [String(i + 1), t]));

const q = (question: string, ...optionTexts: string[]) => ({
  question,
  options: options(...optionTexts),
});

describe('questionTokenSet', () => {
  it('ignores case, punctuation and word order', () => {
    expect(
      jaccard(
        questionTokenSet('Wug, lorp. Blint!'),
        questionTokenSet('blint WUG lorp'),
      ),
    ).toBe(1);
  });

  it('keeps digits, which often carry the whole difference between two stems', () => {
    expect(questionTokenSet('wug 4')).toContain('4');
  });

  it('splits on punctuation so a hyphenated number is still a number', () => {
    expect(questionTokenSet('5-lorp')).toContain('5');
  });

  it('strips English question scaffolding, which carries no topic signal', () => {
    expect(questionTokenSet('in how many ways can it be')).not.toContain('how');
  });
});

describe('optionSetKey', () => {
  it('is independent of option order, so a shuffle cannot hide a repeat', () => {
    expect(optionSetKey(options('a', 'b', 'c', 'd'))).toBe(
      optionSetKey(options('d', 'c', 'b', 'a')),
    );
  });

  it('differs when the answers themselves differ', () => {
    expect(optionSetKey(options('a', 'b'))).not.toBe(
      optionSetKey(options('c', 'd')),
    );
  });

  it('is empty for a missing option object', () => {
    expect(optionSetKey(undefined)).toBe('');
  });
});

describe('numeric discrimination', () => {
  it('reads the numbers out of a stem', () => {
    expect(
      Array.from(numericTokens(questionTokenSet('wug 4 lorp 6'))).sort(),
    ).toEqual(['4', '6']);
  });

  it('treats stems with no numbers as comparable', () => {
    expect(sameNumbers(new Set(), new Set())).toBe(true);
  });

  it('separates identical wording carrying different quantities', () => {
    expect(
      sameNumbers(
        numericTokens(questionTokenSet(stem(5, 4))),
        numericTokens(questionTokenSet(stem(5, 6))),
      ),
    ).toBe(false);
  });
});

describe('findDuplicateQuestions', () => {
  it('drops a reworded restatement and keeps the first occurrence', () => {
    const duplicates = findDuplicateQuestions([
      q(stem(6), 'a', 'b'),
      q(reworded(6), 'a', 'b'),
    ]);
    expect(duplicates.map((d) => d.index)).toEqual([1]);
  });

  it('drops a repeat whose options were merely shuffled', () => {
    const duplicates = findDuplicateQuestions([
      q(stem(6), 'a', 'b', 'c', 'd'),
      q(reworded(6), 'd', 'c', 'b', 'a'),
    ]);
    expect(duplicates).toHaveLength(1);
  });

  it('keeps stems that differ only by a quantity, however close the wording', () => {
    expect(
      findDuplicateQuestions([q(stem(6, 4), 'a'), q(stem(6, 6), 'b')]),
    ).toHaveLength(0);
  });

  it('keeps stems that share some words but not enough', () => {
    const a = W.slice(0, 4).join(' ');
    const b = W.slice(4, 8).join(' ');
    expect(findDuplicateQuestions([q(a, 'x'), q(b, 'y')])).toHaveLength(0);
  });

  it('drops a question that restates one already in the bank', () => {
    const duplicates = findDuplicateQuestions([q(reworded(6), 'a')], [stem(6)]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reason).toContain('already in the bank');
  });

  it('never drops every copy of a repeated question', () => {
    const batch = [q(stem(6), 'a'), q(reworded(6), 'a'), q(stem(6), 'a')];
    expect(findDuplicateQuestions(batch)).toHaveLength(batch.length - 1);
  });

  it('reports indices into the batch it was given', () => {
    const other = W.slice(4, 8).join(' ');
    const duplicates = findDuplicateQuestions([
      q(other, 'x'),
      q(stem(6), 'a'),
      q(stem(6), 'a'),
    ]);
    expect(duplicates.map((d) => d.index)).toEqual([2]);
  });

  it('leaves an empty batch alone', () => {
    expect(findDuplicateQuestions([])).toEqual([]);
  });

  it('does not throw on a malformed question object', () => {
    expect(() =>
      findDuplicateQuestions([{ question: '', options: undefined }]),
    ).not.toThrow();
  });

  it('ignores blank entries in the existing-question list', () => {
    expect(findDuplicateQuestions([q(stem(6), 'a')], ['', '   '])).toHaveLength(
      0,
    );
  });
});

describe('independence from language', () => {
  /**
   * The stopword list is English. In any other language nothing is stripped,
   * every stem keeps its scaffolding words and similarity rises across the
   * board. The numeric rule is what has to hold there, so it is checked with
   * words no stopword list recognises.
   */
  it('still catches a true restatement it cannot strip a single word from', () => {
    const base = stem(6);
    expect(
      findDuplicateQuestions([q(base, 'a'), q(`${base} skarn`, 'a')]),
    ).toHaveLength(1);
  });

  it('does not drop a differing stem just because it cannot strip the scaffolding', () => {
    expect(
      findDuplicateQuestions([q(stem(7, 4), 'a'), q(stem(7, 6), 'b')]),
    ).toHaveLength(0);
  });
});

describe('semantic duplicate detection', () => {
  // Stand-ins for embeddings. Direction carries the meaning; magnitude does
  // not, since cosine normalises it.
  const SAME_MEANING_A = [1, 0, 0, 0];
  const SAME_MEANING_B = [0.99, 0.1, 0, 0];
  const DIFFERENT_MEANING = [0, 1, 0, 0];

  it('scores identical vectors as 1 and orthogonal ones as 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('ignores magnitude, so vector length cannot change a verdict', () => {
    expect(cosineSimilarity([1, 0], [7, 0])).toBeCloseTo(1);
  });

  it('returns 0 rather than throwing on empty or mismatched vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('catches a paraphrase that shares almost no wording', () => {
    // The case token overlap cannot see: same question, different words.
    const a = describeQuestionText('which structure uses lifo');
    const b = describeQuestionText('which structure follows last in first out');
    expect(jaccard(a.tokens, b.tokens)).toBeLessThan(DUPLICATE_STEM_THRESHOLD);

    expect(
      isSemanticDuplicate(a, b, SAME_MEANING_A, SAME_MEANING_B),
    ).not.toBeNull();
  });

  it('leaves questions that merely share a subject alone', () => {
    const a = describeQuestionText('which structure uses lifo');
    const b = describeQuestionText('which structure uses fifo');
    expect(
      isSemanticDuplicate(a, b, SAME_MEANING_A, DIFFERENT_MEANING),
    ).toBeNull();
  });

  it('never merges two questions that pose different quantities', () => {
    // The guard that matters most here: "arrange 3 books" and "arrange 5
    // books" sit almost on top of each other in embedding space and are
    // different questions. Meaning cannot separate them; the digits can.
    const a = describeQuestionText('arrange 3 items in a row');
    const b = describeQuestionText('arrange 5 items in a row');
    expect(
      isSemanticDuplicate(a, b, SAME_MEANING_A, SAME_MEANING_A),
    ).toBeNull();
  });

  it('still merges identical quantities phrased differently', () => {
    const a = describeQuestionText('arrange 3 items in a row');
    const b = describeQuestionText('count the orderings of 3 items');
    expect(
      isSemanticDuplicate(a, b, SAME_MEANING_A, SAME_MEANING_B),
    ).not.toBeNull();
  });

  it('respects an explicitly supplied threshold', () => {
    const a = describeQuestionText('alpha beta');
    const b = describeQuestionText('gamma delta');
    expect(isSemanticDuplicate(a, b, [1, 0], [0.8, 0.6], 0.9)).toBeNull();
    expect(isSemanticDuplicate(a, b, [1, 0], [0.8, 0.6], 0.7)).not.toBeNull();
  });
});
