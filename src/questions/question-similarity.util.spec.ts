import {
  DUPLICATE_STEM_THRESHOLD,
  cosineSimilarity,
  describeQuestionText,
  findDuplicateQuestions,
  exerciseFingerprint,
  findTemplateRepeats,
  questionSkeleton,
  SAME_TEMPLATE_THRESHOLD,
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

describe('template repeats', () => {
  /**
   * A bank can hold no duplicates and still be repetitive. A review of 40
   * generated statistics questions found no exact repeats, but seven of them
   * were "remove a value, then take the mean" with the numbers changed, three
   * were "what is the range", and three were "what is the standard
   * deviation".
   *
   * The numeric guard that keeps "arrange 3 books" separate from "arrange 5
   * books" is precisely what lets those through, so this check strips the
   * numbers instead of relying on them.
   */
  const range = (...values: number[]) => ({
    question: `What is the range of ${values.join(', ')}?`,
    options: { '1': 'a', '2': 'b' },
  });

  const mode = (...values: number[]) => ({
    question: `What is the mode of ${values.join(', ')}?`,
    options: { '1': 'a', '2': 'b' },
  });

  it('sees past the data to the exercise underneath', () => {
    const a = questionSkeleton('What is the range of 4, 6, 8, 10?');
    const b = questionSkeleton('What is the range of 2, 4, 6, 8?');
    expect(jaccard(a, b)).toBe(1);
  });

  it('keeps different exercises apart even over identical data', () => {
    const a = questionSkeleton('What is the mean of 1, 2, 2, 3, 4?');
    const b = questionSkeleton('What is the mode of 1, 2, 2, 3, 4?');
    expect(jaccard(a, b)).toBeLessThan(SAME_TEMPLATE_THRESHOLD);
  });

  it('allows a template twice and flags the surplus', () => {
    const batch = [
      range(4, 6, 8, 10),
      range(2, 4, 6, 8),
      range(40, 50, 60, 70),
    ];
    const surplus = findTemplateRepeats(batch);

    expect(surplus.map((s) => s.index)).toEqual([2]);
  });

  it('does not flag a batch of genuinely different exercises', () => {
    const batch = [
      range(4, 6, 8, 10),
      mode(5, 8, 8, 12),
      {
        question: 'Which measure of centre is least affected by an outlier?',
        options: { '1': 'a', '2': 'b' },
      },
    ];
    expect(findTemplateRepeats(batch)).toHaveLength(0);
  });

  it('counts templates already in the bank against the new batch', () => {
    // Two already exist, so the first new one is already the third.
    const surplus = findTemplateRepeats(
      [range(1, 2, 3, 4)],
      ['What is the range of 4, 6, 8, 10?', 'What is the range of 2, 4, 6, 8?'],
    );
    expect(surplus).toHaveLength(1);
    expect(surplus[0].reason).toContain('the same wording over different data');
  });

  it('honours a caller-supplied cap', () => {
    const batch = [range(1, 2), range(3, 4), range(5, 6)];
    expect(findTemplateRepeats(batch, [], 1).map((s) => s.index)).toEqual([
      1, 2,
    ]);
    expect(findTemplateRepeats(batch, [], 3)).toHaveLength(0);
  });

  it('ignores questions with no words left once numbers are stripped', () => {
    expect(() =>
      findTemplateRepeats([{ question: '4 6 8 10', options: {} }]),
    ).not.toThrow();
  });
});

describe('same exercise under a different noun', () => {
  /**
   * A batch of 50 permutation questions repeated one exercise seven times by
   * changing only the object: trophies, markers, ribbons, hats, flags, and
   * twice students. Every one was "arrange 3 distinct things" with the answer
   * 6. Four more were the same at 4 -> 24.
   *
   * None of the wording rules can see it. The nouns differ, so the token sets
   * differ, the skeletons differ, and the embeddings sit below the paraphrase
   * threshold. What does not differ is the arithmetic: same numbers in, same
   * answer out.
   *
   * Question texts here are the real ones, shortened. They are the evidence
   * for the rule, and a synthetic stand-in would not show that the nouns are
   * the only thing that moved.
   */
  const arrange3 = [
    {
      question: '3 trophies on a shelf, each unique',
      options: { '1': '9', '2': '6', '3': '12', '4': '3' },
      correctOption: 2,
    },
    {
      question: '3 different colored markers on a desk in a row',
      options: { '1': '9', '2': '6', '3': '12', '4': '3' },
      correctOption: 2,
    },
    {
      question: '3 different colored ribbons on a shelf',
      options: { '1': '6', '2': '8', '3': '9', '4': '3' },
      correctOption: 1,
    },
    {
      question: '3 different colored flags on a flagpole',
      options: { '1': '6', '2': '12', '3': '3', '4': '9' },
      correctOption: 1,
    },
    {
      question: '3 students in a row for a class photo',
      options: { '1': '6', '2': '3', '3': '9', '4': '12' },
      correctOption: 1,
    },
  ];

  it('reduces the same computation to one fingerprint whatever the noun', () => {
    const prints = arrange3.map(exerciseFingerprint);
    expect(new Set(prints).size).toBe(1);
    expect(prints[0]).toBe('3=>6');
  });

  it('flags the surplus copies that the wording rules let through', () => {
    // Proof the wording rules cannot: the first two share no skeleton.
    expect(
      jaccard(
        questionSkeleton(arrange3[0].question),
        questionSkeleton(arrange3[3].question),
      ),
    ).toBeLessThan(SAME_TEMPLATE_THRESHOLD);

    // Two kept, three surplus.
    expect(findTemplateRepeats(arrange3).map((t) => t.index)).toEqual([
      2, 3, 4,
    ]);
  });

  it('separates a different quantity even under the same noun', () => {
    const four = {
      question: '4 students in a line for a group photo',
      options: { '1': '16', '2': '24', '3': '12', '4': '36' },
      correctOption: 2,
    };
    expect(exerciseFingerprint(four)).toBe('4=>24');
    expect(exerciseFingerprint(four)).not.toBe(
      exerciseFingerprint(arrange3[0]),
    );
  });

  it('counts fingerprints already in the bank', () => {
    const surplus = findTemplateRepeats(
      [arrange3[4]],
      [arrange3[0], arrange3[1]],
    );
    expect(surplus).toHaveLength(1);
    expect(surplus[0].reason).toContain('same numbers and the same answer');
  });

  it('falls back to wording when there is nothing to fingerprint', () => {
    // No numbers in the question, so no fingerprint; the skeleton still works.
    const noNumbers = {
      question: 'which measure resists an outlier',
      options: { '1': 'a' },
      correctOption: 1,
    };
    expect(exerciseFingerprint(noNumbers)).toBe('');
    expect(() => findTemplateRepeats([noNumbers])).not.toThrow();
  });

  it('does not fingerprint when the keyed option is missing', () => {
    expect(
      exerciseFingerprint({
        question: 'arrange 3 things',
        options: { '1': '6' },
        correctOption: 4,
      }),
    ).toBe('');
  });
});
