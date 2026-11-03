require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { OpenAI } = require('openai');

/**
 * Measurement only. Answers a sample of stored MCQs with a fresh LLM call and
 * reports how the model's answer relates to the stored correctOption.
 *
 * Three outcomes are reported separately, because they are different defects
 * needing different fixes:
 *   agree        the model picks the stored option
 *   disagree     the model picks a different one of the four (mis-keyed answer)
 *   none_correct the model's computed answer is not among the four options
 *
 * The third is why the model is asked to SOLVE FIRST and only then look for
 * its answer among the options. An earlier version offered only the four
 * options, so a question with no correct answer forced a pick; when that pick
 * happened to match the stored key it was scored as agreement, hiding the
 * defect entirely.
 *
 * This does NOT decide whether a stored answer is wrong. Either side can be at
 * fault, and the escape hatch can be over-used, so every none_correct verdict
 * is written out with the answer the model computed and all four option texts
 * for review by hand.
 *
 * The model sees only the question text and the four options. It never sees
 * the stored answer, the topic, the difficulty, the generation prompt or any
 * other context. Temperature is 0.
 *
 * Reads only: the database session is set READ ONLY before any query, so the
 * script cannot write even by mistake. Nothing is wired into the app.
 *
 * Usage:
 *   node scripts/measure-answer-disagreement.js
 *       dry run: shows the sample plan and makes no LLM calls
 *   node scripts/measure-answer-disagreement.js --confirm
 *       samples, calls the LLM once per question, writes the report
 *
 * Options:
 *   --limit N        sample size (default 200)
 *   --concurrency N  parallel LLM calls (default 4)
 *   --model NAME     model id (default gpt-4.1, matching OpenAIProvider)
 *   --seed F         float in [-1,1] making the sample reproducible; re-running
 *                    with the same seed and limit picks the same questions
 *   --ids A,B,C      check exactly these question ids instead of sampling
 *   --ids-file PATH  same, reading a JSON array of ids (or a file with an
 *                    "ids"/"disagreementIds"/"noneCorrectIds" array)
 *   --out PATH       output file (default scripts/out/answer-disagreement-<ts>.json)
 *
 * Targets the same schema as the migration runner: "stage_template" when
 * ENV_NOTE=stage_template, otherwise "main".
 */

const TABLE = 'zuvy_questions';
const DEFAULT_LIMIT = 200;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MODEL = 'gpt-4.1';
const OPTION_KEYS = ['1', '2', '3', '4'];

function targetSchema() {
  return process.env.ENV_NOTE === 'stage_template' ? 'stage_template' : 'main';
}

function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function parseIdList(text) {
  const trimmed = String(text).trim();
  let raw;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    raw = Array.isArray(parsed)
      ? parsed
      : parsed.ids ?? parsed.disagreementIds ?? parsed.noneCorrectIds;
    if (!Array.isArray(raw)) {
      throw new Error('id file must be a JSON array, or hold ids / disagreementIds / noneCorrectIds');
    }
  } else {
    raw = trimmed.split(',');
  }
  const ids = raw.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Error('no usable question ids found');
  return ids;
}

function parseArgs(argv) {
  const opts = {
    confirmed: false,
    limit: DEFAULT_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    model: DEFAULT_MODEL,
    seed: null,
    ids: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') opts.confirmed = true;
    else if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (arg === '--model') opts.model = String(argv[++i]);
    else if (arg === '--seed') opts.seed = Number(argv[++i]);
    else if (arg === '--ids') opts.ids = parseIdList(argv[++i]);
    else if (arg === '--ids-file') opts.ids = parseIdList(fs.readFileSync(argv[++i], 'utf8'));
    else if (arg === '--out') opts.out = String(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  if (opts.seed !== null && !(opts.seed >= -1 && opts.seed <= 1)) {
    throw new Error('--seed must be a number between -1 and 1');
  }
  return opts;
}

/** Only questions with all four options present and a stored answer among them. */
function isUsable(row) {
  const options = row.options;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  for (const key of OPTION_KEYS) {
    const value = options[key];
    if (typeof value !== 'string' || !value.trim()) return false;
  }
  return OPTION_KEYS.includes(String(row.correct_option));
}

const SELECT_COLUMNS = 'id, question, options, correct_option, topic_name, difficulty';

async function fetchByIds(db, schema, ids) {
  const table = `${quote(schema)}.${quote(TABLE)}`;
  const res = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE id = ANY($1::int[]) ORDER BY id`,
    [ids],
  );
  const usable = res.rows.filter(isUsable);
  return { cellCount: 0, rows: usable, rejected: res.rows.length - usable.length };
}

/**
 * Spreads the sample over (topic, difficulty) cells instead of taking a plain
 * random 200, which would be dominated by whichever topics happen to be large.
 */
async function sampleQuestions(db, schema, limit) {
  const table = `${quote(schema)}.${quote(TABLE)}`;

  const cells = await db.query(
    `SELECT count(*)::int AS n
       FROM (SELECT DISTINCT topic_name, difficulty FROM ${table}) c`,
  );
  const cellCount = Math.max(cells.rows[0].n, 1);
  const perCell = Math.max(Math.ceil((limit * 2) / cellCount), 2);

  const sampled = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM (
         SELECT ${SELECT_COLUMNS},
                row_number() OVER (
                  PARTITION BY topic_name, difficulty ORDER BY random()
                ) AS rn
           FROM ${table}
          WHERE question IS NOT NULL AND options IS NOT NULL
       ) t
      WHERE rn <= $1
      ORDER BY random()
      LIMIT $2`,
    [perCell, limit * 2],
  );

  const usable = sampled.rows.filter(isUsable);
  return {
    cellCount,
    rows: usable.slice(0, limit),
    rejected: sampled.rows.length - usable.length,
  };
}

/**
 * Solve-then-match. The requested key order matters: the model writes
 * "computedAnswer" before "correctOption", so it commits to an answer before
 * it considers the options, rather than reading the options and rationalising
 * a pick. Without that ordering a question with no correct option gets a
 * forced choice and the defect stays invisible.
 */
function buildPrompt(row) {
  const options = OPTION_KEYS.map((k) => `${k}. ${row.options[k]}`).join('\n');
  return [
    'Solve this multiple-choice question.',
    '',
    'Question:',
    row.question,
    '',
    'Options:',
    options,
    '',
    'Work in this order:',
    '1. Solve the question yourself and state your answer, before considering the options.',
    '2. Then check whether your answer appears among the four options above.',
    '',
    'Respond with ONLY a JSON object of exactly this shape, keys in this order:',
    '{"computedAnswer": "<your answer, stated plainly>", "correctOption": <1, 2, 3, 4 or null>}',
    '',
    'Set "correctOption" to the number of the option matching your computed answer.',
    'Match on value and meaning, not on exact wording, units formatting or rounding style.',
    'Set "correctOption" to null only when none of the four options expresses your answer.',
    'Do not pick the nearest option when none matches: null is the correct response there.',
    '',
    'No explanation, no markdown, no code fences.',
  ].join('\n');
}

/**
 * Returns null when the response could not be read at all. A verdict of
 * {correctOption: null} is a real answer ("none of these"), not a failure, so
 * the two must not collapse into one.
 */
function extractVerdict(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!('correctOption' in parsed)) return null;

  const computedAnswer =
    typeof parsed.computedAnswer === 'string' ? parsed.computedAnswer.trim() : null;
  const value = parsed.correctOption;

  if (value === null) return { computedAnswer, correctOption: null };
  const num = Number(value);
  if (!OPTION_KEYS.includes(String(num))) return null;
  return { computedAnswer, correctOption: num };
}

async function askModel(ai, model, row) {
  const res = await ai.responses.create({
    model,
    input: buildPrompt(row),
    temperature: 0,
  });
  return { verdict: extractVerdict(res.output_text), usage: res.usage ?? null };
}

/** Fixed-size worker pool; keeps ordering of results by index. */
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

function rateTable(records, key) {
  const buckets = new Map();
  for (const record of records) {
    if (record.outcome === 'error') continue;
    const name = record[key] || '(none)';
    const b = buckets.get(name) ?? { checked: 0, agree: 0, disagree: 0, noneCorrect: 0 };
    b.checked++;
    if (record.outcome === 'agree') b.agree++;
    else if (record.outcome === 'disagree') b.disagree++;
    else if (record.outcome === 'none_correct') b.noneCorrect++;
    buckets.set(name, b);
  }
  return [...buckets.entries()]
    .map(([name, b]) => ({
      name,
      checked: b.checked,
      agree: b.agree,
      disagree: b.disagree,
      noneCorrect: b.noneCorrect,
      disagreeRate: b.checked ? b.disagree / b.checked : 0,
      noneCorrectRate: b.checked ? b.noneCorrect / b.checked : 0,
      problemRate: b.checked ? (b.disagree + b.noneCorrect) / b.checked : 0,
    }))
    .sort((a, b) => b.problemRate - a.problemRate || b.checked - a.checked);
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function printRateTable(title, rows) {
  console.log('');
  console.log(title);
  console.log('  checked  agree  disagree  none   disagree%   none%   name');
  for (const r of rows) {
    console.log(
      '  ' +
        String(r.checked).padStart(7) +
        String(r.agree).padStart(7) +
        String(r.disagree).padStart(10) +
        String(r.noneCorrect).padStart(7) +
        pct(r.disagreeRate).padStart(12) +
        pct(r.noneCorrectRate).padStart(8) +
        '   ' +
        r.name,
    );
  }
}

async function main(confirmed, opts) {
  const schema = targetSchema();
  if (!['stage_template', 'main'].includes(schema)) {
    throw new Error(`Refusing unknown schema ${schema}`);
  }
  if (confirmed && !process.env.OPENAI_KEY) {
    throw new Error('OPENAI_KEY is not set');
  }

  const db = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 5432),
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    // Belt and braces: the session cannot write, whatever the queries say.
    await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

    console.log(`database: ${process.env.DB_NAME}   schema: ${schema}   model: ${opts.model}`);

    let plan;
    if (opts.ids) {
      plan = await fetchByIds(db, schema, opts.ids);
      console.log(`checking ${plan.rows.length} question(s) by id`);
    } else {
      if (opts.seed !== null) {
        await db.query('SELECT setseed($1)', [opts.seed]);
        console.log(`sample seed: ${opts.seed} (re-runnable)`);
      }
      plan = await sampleQuestions(db, schema, opts.limit);
      console.log(
        `sampled ${plan.rows.length} question(s) across ${plan.cellCount} topic/difficulty cell(s)`,
      );
    }
    if (plan.rejected) {
      console.log(`${plan.rejected} skipped for missing options or an out-of-range stored answer`);
    }

    const rows = plan.rows;
    if (!rows.length) throw new Error('no usable questions to check');

    if (!confirmed) {
      console.log('');
      console.log('Dry run: no LLM calls made, nothing written.');
      console.log(`Re-run with --confirm to answer all ${rows.length} question(s):`);
      console.log('  node scripts/measure-answer-disagreement.js --confirm');
      return;
    }

    const ai = new OpenAI({ apiKey: process.env.OPENAI_KEY, timeout: 120000, maxRetries: 2 });
    let done = 0;

    const records = await runPool(rows, opts.concurrency, async (row) => {
      const stored = Number(row.correct_option);
      let result;
      try {
        result = await askModel(ai, opts.model, row);
      } catch (err) {
        result = { verdict: null, usage: null, error: String(err && err.message) };
      }
      done++;
      if (done % 20 === 0 || done === rows.length) {
        console.log(`  answered ${done}/${rows.length}`);
      }

      const verdict = result.verdict;
      let outcome;
      if (!verdict) outcome = 'error';
      else if (verdict.correctOption === null) outcome = 'none_correct';
      else if (verdict.correctOption === stored) outcome = 'agree';
      else outcome = 'disagree';

      return {
        id: row.id,
        topic: row.topic_name,
        difficulty: row.difficulty,
        storedCorrectOption: stored,
        storedOptionText: row.options[String(stored)] ?? null,
        modelCorrectOption: verdict ? verdict.correctOption : null,
        computedAnswer: verdict ? verdict.computedAnswer : null,
        outcome,
        error: result.error ?? null,
        usage: result.usage,
        question: row.question,
        options: row.options,
      };
    });

    const checked = records.filter((r) => r.outcome !== 'error');
    const agreed = records.filter((r) => r.outcome === 'agree');
    const disagreed = records.filter((r) => r.outcome === 'disagree');
    const noneCorrect = records.filter((r) => r.outcome === 'none_correct');
    const errors = records.filter((r) => r.outcome === 'error');
    const denom = checked.length || 1;

    const tokens = records.reduce(
      (acc, r) => {
        acc.input += r.usage?.input_tokens ?? 0;
        acc.output += r.usage?.output_tokens ?? 0;
        return acc;
      },
      { input: 0, output: 0 },
    );

    console.log('');
    console.log('=== RESULT ===');
    console.log(`checked:                       ${checked.length}`);
    console.log(
      `agrees with stored:            ${agreed.length}  (${pct(agreed.length / denom)})`,
    );
    console.log(
      `disagrees, picks one of four:  ${disagreed.length}  (${pct(disagreed.length / denom)})`,
    );
    console.log(
      `says no option is correct:     ${noneCorrect.length}  (${pct(noneCorrect.length / denom)})`,
    );
    console.log(`errors (excluded):             ${errors.length}`);
    console.log(`tokens: ${tokens.input} in / ${tokens.output} out`);

    printRateTable('By difficulty:', rateTable(records, 'difficulty'));
    printRateTable('By topic:', rateTable(records, 'topic'));

    const detail = (r) => ({
      id: r.id,
      topic: r.topic,
      difficulty: r.difficulty,
      storedCorrectOption: r.storedCorrectOption,
      storedOptionText: r.storedOptionText,
      modelCorrectOption: r.modelCorrectOption,
      computedAnswer: r.computedAnswer,
      question: r.question,
      options: r.options,
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath =
      opts.out ?? path.join(__dirname, 'out', `answer-disagreement-${stamp}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          database: process.env.DB_NAME,
          schema,
          model: opts.model,
          temperature: 0,
          seed: opts.seed,
          idsGiven: opts.ids ? opts.ids.length : null,
          sampled: rows.length,
          checked: checked.length,
          agreed: agreed.length,
          disagreed: disagreed.length,
          noneCorrect: noneCorrect.length,
          errors: errors.length,
          disagreeRate: disagreed.length / denom,
          noneCorrectRate: noneCorrect.length / denom,
          tokens,
          byDifficulty: rateTable(records, 'difficulty'),
          byTopic: rateTable(records, 'topic'),

          // Mis-keyed: the model picked a different one of the four.
          disagreementIds: disagreed.map((r) => r.id),
          disagreements: disagreed.map(detail),

          // Missing correct option: a different defect, needing a different
          // fix. computedAnswer plus all four option texts are included so a
          // reviewer can judge whether the model is right or just reaching for
          // the escape hatch.
          noneCorrectIds: noneCorrect.map((r) => r.id),
          noneCorrect: noneCorrect.map(detail),
        },
        null,
        2,
      ),
    );

    console.log('');
    console.log(
      `Wrote ${disagreed.length} mis-keyed and ${noneCorrect.length} missing-option case(s) to ${outPath}`,
    );
    console.log('Neither category is proof the stored answer is wrong. Review by hand:');
    console.log('  disagreements  -> is the stored key wrong, or is the model wrong?');
    console.log('  noneCorrect    -> does computedAnswer really differ from all four options?');
  } finally {
    await db.end();
  }
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

module.exports = {
  main,
  targetSchema,
  buildPrompt,
  extractVerdict,
  isUsable,
  rateTable,
  TABLE,
};
