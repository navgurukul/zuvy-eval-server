require('dotenv').config();
const fs = require('fs');
const path = require('path');

/**
 * Turns CONCEPT_SIMILARITY_THRESHOLD from a guess into a measurement.
 *
 * The concept check groups a batch by meaning rather than by wording, because
 * a concept asked several different ways shares almost no words and every
 * wording check keeps all of it. What counts as "the same concept" is a single
 * number, and that number cannot be reasoned out from first principles: two
 * questions on one subject always sit closer together than two questions on
 * different subjects, so a threshold that is right for a broad topic groups
 * everything on a narrow one.
 *
 * This prints what each candidate threshold would actually do to a set of real
 * questions, so the value can be chosen from the corpus. Run it on a batch that
 * has already been reviewed, where the clusters are known by eye, and pick the
 * threshold whose grouping matches what a reader would say.
 *
 * Reads questions from a JSON file. Either shape works:
 *
 *   ["question one", "question two", ...]
 *   [{ "question": "question one" }, ...]
 *   { "evaluations": [{ "question": "..." }, ...] }
 *
 * Touches no database and writes nothing. One embedding call.
 *
 * Usage:
 *   node scripts/measure-concept-clusters.js questions.json
 *   node scripts/measure-concept-clusters.js questions.json --confirm
 *
 * Options:
 *   --cap N   questions allowed per concept when reporting surplus (default 3)
 */

const DIST = path.join(__dirname, '..', 'dist');
const CANDIDATE_THRESHOLDS = [0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.92, 0.94];

function parseArgs(argv) {
  const opts = { confirmed: false, file: null, cap: 3 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') opts.confirmed = true;
    else if (arg === '--cap') opts.cap = Number(argv[++i]);
    else if (!opts.file) opts.file = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!opts.file) throw new Error('A questions JSON file is required.');
  if (!Number.isInteger(opts.cap) || opts.cap < 1) {
    throw new Error('--cap must be a positive integer');
  }
  return opts;
}

function readQuestions(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : (parsed.evaluations ?? []);
  const questions = list
    .map((item) => (typeof item === 'string' ? item : item?.question))
    .map((text) => String(text ?? '').trim())
    .filter(Boolean);
  if (!questions.length) {
    throw new Error(`No questions found in ${file}`);
  }
  return questions;
}

/** Percentile of a sorted array, for describing the similarity spread. */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function main(opts) {
  const questions = readQuestions(opts.file);
  console.log(`file:      ${opts.file}`);
  console.log(`questions: ${questions.length}`);
  console.log(`cap:       ${opts.cap} per concept`);
  console.log('');

  if (!opts.confirmed) {
    console.log('Dry run: no embedding call made. Re-run with --confirm.');
    console.log(`  node scripts/measure-concept-clusters.js ${opts.file} --confirm`);
    return;
  }

  const {
    EmbeddingsService,
  } = require(path.join(DIST, 'llm/embeddings.service'));
  const {
    cosineSimilarity,
    findConceptRepeats,
  } = require(path.join(DIST, 'questions/question-similarity.util'));

  const vectors = await new EmbeddingsService().embedMany(questions);

  // How close these questions sit to each other at all. A narrow topic pushes
  // the whole distribution up, which is exactly why one fixed threshold cannot
  // serve every topic and why this has to be looked at per corpus.
  const pairs = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      pairs.push(cosineSimilarity(vectors[i], vectors[j]));
    }
  }
  pairs.sort((a, b) => a - b);

  console.log('pairwise similarity across this set:');
  for (const p of [50, 75, 90, 95, 99]) {
    console.log(`  p${String(p).padEnd(2)} ${percentile(pairs, p).toFixed(3)}`);
  }
  console.log(`  max  ${pairs[pairs.length - 1].toFixed(3)}`);
  console.log('');

  const items = questions.map((question, i) => ({
    question,
    vector: vectors[i],
  }));

  console.log('what each threshold would do:');
  console.log('  threshold  flagged  note');
  for (const threshold of CANDIDATE_THRESHOLDS) {
    const repeats = findConceptRepeats(items, opts.cap, threshold);
    // findConceptRepeats returns nothing when it would flag most of the batch,
    // so a zero here can mean either "nothing to flag" or "refused to act".
    const wouldFlagMost = repeats.length === 0 && threshold <= percentile(pairs, 50);
    const note = wouldFlagMost
      ? 'below the median pair: likely refused as miscalibrated'
      : repeats.length === 0
        ? 'no concept exceeds the cap'
        : '';
    console.log(
      `  ${threshold.toFixed(2)}       ${String(repeats.length).padStart(3)}      ${note}`,
    );
  }
  console.log('');

  const current = Number(process.env.CONCEPT_SIMILARITY_THRESHOLD ?? 0.88);
  const atCurrent = findConceptRepeats(items, opts.cap, current);
  console.log(`at the configured threshold (${current}), these would be dropped:`);
  if (!atCurrent.length) {
    console.log('  (none)');
  }
  for (const repeat of atCurrent) {
    console.log(`  [${repeat.index}] sim ${repeat.similarity.toFixed(3)}`);
    console.log(`      ${questions[repeat.index].slice(0, 100)}`);
    console.log(`      ${repeat.reason}`);
  }
}

try {
  const opts = parseArgs(process.argv.slice(2));
  main(opts).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
