require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Same prompt and same parser as the measurement run, imported rather than
// copied so the two cannot drift apart. That module does nothing on require.
const { buildPrompt, extractVerdict } = require('./measure-answer-disagreement');

/**
 * Measurement only. Asks two different models the same questions and reports
 * where they agree with each other and with the stored answer.
 *
 * The question is whether a second opinion buys anything. Two outcomes matter:
 *   - the models differ from each other  -> voting would flag these
 *   - both pick the same non-stored option -> voting buys nothing here; they
 *     make the same mistake, so a second model is not a safety net
 *
 * Reads questions from a previous measure-answer-disagreement output file, so
 * it touches no database at all. Temperature 0 for both models.
 *
 * Usage:
 *   node scripts/compare-verifier-models.js --from scripts/out/<file>.json
 *   node scripts/compare-verifier-models.js --from <file>.json --confirm
 *
 * Options:
 *   --from PATH       previous output file (required)
 *   --models A,B      comma-separated model ids
 *                     (default gpt-4.1,gemini-2.5-flash)
 *   --set NAME        which array to read: disagreements (default), noneCorrect, both
 *   --limit N         only the first N questions (handy for a cheap trial run)
 *   --highlight IDS   comma-separated question ids to print in full
 *   --concurrency N   parallel calls per model (default 4)
 *   --out PATH        output file (default scripts/out/verifier-comparison-<ts>.json)
 *
 * Note: the app's GenAIProvider still names "gemini-pro", which is an old
 * model id. If a Gemini call fails with a model-not-found error, pass a
 * current id with --models.
 */

const DEFAULT_MODELS = ['gpt-4.1', 'gemini-2.5-flash'];
const DEFAULT_CONCURRENCY = 4;

function parseArgs(argv) {
  const opts = {
    confirmed: false,
    from: null,
    models: DEFAULT_MODELS.slice(),
    set: 'disagreements',
    limit: null,
    highlight: [],
    concurrency: DEFAULT_CONCURRENCY,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') opts.confirmed = true;
    else if (arg === '--from') opts.from = String(argv[++i]);
    else if (arg === '--models') opts.models = String(argv[++i]).split(',').map((s) => s.trim());
    else if (arg === '--set') opts.set = String(argv[++i]);
    else if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '--highlight')
      opts.highlight = String(argv[++i]).split(',').map((s) => Number(s.trim()));
    else if (arg === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (arg === '--out') opts.out = String(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.from) throw new Error('--from <previous output file> is required');
  if (opts.models.length !== 2) throw new Error('--models needs exactly two model ids');
  if (!['disagreements', 'noneCorrect', 'both'].includes(opts.set)) {
    throw new Error('--set must be disagreements, noneCorrect or both');
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  return opts;
}

function loadRows(file, set) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const arrays =
    set === 'both'
      ? [...(data.disagreements ?? []), ...(data.noneCorrect ?? [])]
      : (data[set] ?? []);
  const rows = arrays
    .filter((r) => r && r.question && r.options)
    .map((r) => ({
      id: r.id,
      question: r.question,
      options: r.options,
      // buildPrompt reads correct_option only via isUsable upstream; the
      // prompt itself never sees it. Kept here for scoring only.
      correct_option: r.storedCorrectOption,
      topic_name: r.topic,
      difficulty: r.difficulty,
    }));
  if (!rows.length) throw new Error(`no usable rows in ${file} under "${set}"`);
  return rows;
}

/** One asker per model, so the provider choice lives in a single place. */
function makeAsker(model) {
  if (String(model).toLowerCase().startsWith('gemini')) {
    const client = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);
    const gen = client.getGenerativeModel({
      model,
      generationConfig: { temperature: 0 },
    });
    return async (row) => {
      const res = await gen.generateContent(buildPrompt(row));
      return { verdict: extractVerdict(res.response.text()), usage: null };
    };
  }
  const ai = new OpenAI({ apiKey: process.env.OPENAI_KEY, timeout: 120000, maxRetries: 2 });
  return async (row) => {
    const res = await ai.responses.create({
      model,
      input: buildPrompt(row),
      temperature: 0,
    });
    return { verdict: extractVerdict(res.output_text), usage: res.usage ?? null };
  };
}

/**
 * One real call per model before the full run. A bad key or a model id the
 * project cannot reach then costs two calls and a clear message, instead of
 * failing silently after a whole pass against the other model.
 */
async function preflight(models, row) {
  console.log('preflight: one call per model...');
  for (const model of models) {
    try {
      const { verdict } = await makeAsker(model)(row);
      console.log(
        `  ${model}: OK${verdict ? '' : ' (responded, but the reply could not be parsed)'}`,
      );
    } catch (err) {
      const message = String(err && err.message);
      throw new Error(
        `preflight failed for "${model}": ${message}
` +
          'Nothing further was called. If this is a model-not-found or auth error, ' +
          'pass a reachable id with --models. Ids confirmed available on this key: ' +
          'gemini-2.5-flash, gemini-2.5-pro, gemini-pro-latest, gemini-2.5-flash-lite',
      );
    }
  }
  console.log('');
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function runModel(model, rows, concurrency) {
  const ask = makeAsker(model);
  let done = 0;
  let failures = 0;
  let lastError = null;

  const verdicts = await runPool(rows, concurrency, async (row) => {
    let out;
    try {
      out = await ask(row);
    } catch (err) {
      failures++;
      lastError = String(err && err.message);
      out = { verdict: null, usage: null };
    }
    done++;
    if (done % 10 === 0 || done === rows.length) {
      console.log(`  ${model}: ${done}/${rows.length}`);
    }
    return out;
  });

  if (failures === rows.length) {
    throw new Error(
      `every call to "${model}" failed. Last error: ${lastError}\n` +
        'If this is a model-not-found error, pass a current id with --models.',
    );
  }
  if (failures) console.log(`  ${model}: ${failures} call(s) failed`);
  return verdicts;
}

function label(verdict) {
  if (!verdict) return 'error';
  return verdict.correctOption === null ? 'none' : String(verdict.correctOption);
}

function describe(record, models) {
  console.log('');
  console.log(`--- question ${record.id}  (${record.topic} / ${record.difficulty}) ---`);
  console.log(record.question);
  for (const [k, v] of Object.entries(record.options)) {
    const mark = Number(k) === record.storedCorrectOption ? '  <- stored' : '';
    console.log(`  ${k}. ${v}${mark}`);
  }
  for (const m of models) {
    const r = record.byModel[m];
    console.log(`  ${m}: option ${label(r.verdict)}  computed: ${JSON.stringify(r.computedAnswer)}`);
  }
}

async function main(confirmed, opts) {
  const [modelA, modelB] = opts.models;
  const allRows = loadRows(opts.from, opts.set);
  const rows = opts.limit ? allRows.slice(0, opts.limit) : allRows;

  console.log(`source: ${opts.from}`);
  console.log(
    `set: ${opts.set}   questions: ${rows.length}${opts.limit ? ` (of ${allRows.length}, --limit)` : ''}`,
  );
  console.log(`models: ${modelA} vs ${modelB}   temperature: 0`);

  if (!confirmed) {
    console.log('');
    console.log('Dry run: no LLM calls made, nothing written.');
    console.log(`Re-run with --confirm to ask both models all ${rows.length} question(s):`);
    console.log(`  node scripts/compare-verifier-models.js --from ${opts.from} --confirm`);
    return;
  }
  if (!process.env.OPENAI_KEY) throw new Error('OPENAI_KEY is not set');
  if (opts.models.some((m) => m.toLowerCase().startsWith('gemini')) && !process.env.GOOGLE_GENAI_API_KEY) {
    throw new Error('GOOGLE_GENAI_API_KEY is not set');
  }

  console.log('');
  await preflight(opts.models, rows[0]);
  const resultsA = await runModel(modelA, rows, opts.concurrency);
  const resultsB = await runModel(modelB, rows, opts.concurrency);

  const records = rows.map((row, i) => {
    const stored = Number(row.correct_option);
    const a = resultsA[i].verdict;
    const b = resultsB[i].verdict;
    return {
      id: row.id,
      topic: row.topic_name,
      difficulty: row.difficulty,
      storedCorrectOption: stored,
      question: row.question,
      options: row.options,
      byModel: {
        [modelA]: { verdict: a, computedAnswer: a ? a.computedAnswer : null },
        [modelB]: { verdict: b, computedAnswer: b ? b.computedAnswer : null },
      },
    };
  });

  const usable = records.filter(
    (r) => r.byModel[modelA].verdict && r.byModel[modelB].verdict,
  );

  const pick = (r, m) => r.byModel[m].verdict.correctOption;
  const modelsMatch = usable.filter((r) => pick(r, modelA) === pick(r, modelB));
  const modelsDiffer = usable.filter((r) => pick(r, modelA) !== pick(r, modelB));
  const bothMatchStored = modelsMatch.filter((r) => pick(r, modelA) === r.storedCorrectOption);
  const bothSameWrong = modelsMatch.filter(
    (r) => pick(r, modelA) !== r.storedCorrectOption && pick(r, modelA) !== null,
  );
  const bothNone = modelsMatch.filter((r) => pick(r, modelA) === null);
  const aMatchesStored = usable.filter((r) => pick(r, modelA) === r.storedCorrectOption);
  const bMatchesStored = usable.filter((r) => pick(r, modelB) === r.storedCorrectOption);

  const rate = (n) => `${((n / (usable.length || 1)) * 100).toFixed(1)}%`;

  console.log('');
  console.log('=== RESULT ===');
  console.log(`questions with a verdict from both models: ${usable.length} / ${records.length}`);
  console.log('');
  console.log(`models agree with each other:   ${modelsMatch.length}  (${rate(modelsMatch.length)})`);
  console.log(`  ...and match the stored key:  ${bothMatchStored.length}  (${rate(bothMatchStored.length)})`);
  console.log(`  ...both pick the SAME wrong:  ${bothSameWrong.length}  (${rate(bothSameWrong.length)})  <- voting buys nothing here`);
  console.log(`  ...both say none correct:     ${bothNone.length}  (${rate(bothNone.length)})`);
  console.log(`models differ from each other:  ${modelsDiffer.length}  (${rate(modelsDiffer.length)})  <- voting would flag these`);
  console.log('');
  console.log(`${modelA} matches stored key: ${aMatchesStored.length} (${rate(aMatchesStored.length)})`);
  console.log(`${modelB} matches stored key: ${bMatchesStored.length} (${rate(bMatchesStored.length)})`);

  for (const id of opts.highlight) {
    const record = records.find((r) => r.id === id);
    if (record) describe(record, opts.models);
    else console.log(`\n(question ${id} is not in this set)`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = opts.out ?? path.join(__dirname, 'out', `verifier-comparison-${stamp}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: opts.from,
        set: opts.set,
        models: opts.models,
        temperature: 0,
        questions: records.length,
        bothAnswered: usable.length,
        modelsAgree: modelsMatch.length,
        bothMatchStored: bothMatchStored.length,
        bothSameWrongOption: bothSameWrong.length,
        bothNoneCorrect: bothNone.length,
        modelsDiffer: modelsDiffer.length,
        matchesStoredByModel: {
          [modelA]: aMatchesStored.length,
          [modelB]: bMatchesStored.length,
        },
        modelsDifferIds: modelsDiffer.map((r) => r.id),
        bothSameWrongIds: bothSameWrong.map((r) => r.id),
        records: records.map((r) => ({
          id: r.id,
          topic: r.topic,
          difficulty: r.difficulty,
          storedCorrectOption: r.storedCorrectOption,
          question: r.question,
          options: r.options,
          verdicts: Object.fromEntries(
            opts.models.map((m) => [
              m,
              {
                option: r.byModel[m].verdict ? r.byModel[m].verdict.correctOption : 'error',
                computedAnswer: r.byModel[m].computedAnswer,
              },
            ]),
          ),
        })),
      },
      null,
      2,
    ),
  );

  console.log('');
  console.log(`Wrote ${records.length} comparison(s) to ${outPath}`);
  console.log('Read it this way:');
  console.log('  both same wrong option -> a second model is not a safety net for these');
  console.log('  models differ          -> a vote would surface these for review');
}

// Only runs when invoked directly, never on require. This is the one place
// process.argv is read.
if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  main(opts.confirmed, opts).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main, loadRows, makeAsker };
