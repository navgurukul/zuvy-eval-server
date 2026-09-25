require('dotenv').config();
const path = require('path');

/**
 * Proves the answer-verification path works end to end, before it is trusted
 * in production.
 *
 * QuestionsProcessor now re-solves every generated question with a model that
 * cannot see the key, and drops the question when the two disagree. That check
 * defaults to Gemini so it does not inherit the blind spots of the model that
 * wrote the question - but the Gemini path had never run in production, because
 * the provider fallback was unreachable until it was repaired. An unproven
 * verifier fails in the quietest possible way: if the reply cannot be parsed,
 * every question is "kept unverified" and stored, so verification appears to be
 * on while doing nothing at all. This script is what turns that into a fact.
 *
 * Five cases, on arithmetic plain enough that the model's ability is never the
 * variable under test:
 *
 *   1. keyed correctly          -> must agree       (question is kept)
 *   2. keyed wrongly            -> must disagree    (question is dropped)
 *   3. right answer not present -> must answer null (question is dropped)
 *   4. question matches topic   -> must agree       (question is kept)
 *   5. question is another subject -> must say off topic (question is dropped)
 *
 * Case 3 is the one a forced 1-of-4 choice hides, and it was reported from
 * production alongside the wrong keys.
 *
 * Cases 4 and 5 cover the same silent-failure risk for the relevance review:
 * onTopic is only acted on when it comes back an explicit false, so a provider
 * that omits the field leaves every question on topic by default and the check
 * quietly does nothing. Case 5 is what proves it is actually answering.
 *
 * Deliberately loads the BUILT files from dist/, so it exercises exactly the
 * prompt and parser that would be deployed. Run "npm run build" first.
 *
 * Touches no database and writes nothing. Five LLM calls.
 *
 * Usage:
 *   node scripts/preflight-verifier.js                     # dry run
 *   node scripts/preflight-verifier.js --confirm           # makes the calls
 *
 * Options:
 *   --provider genai|openai   which provider to exercise (default genai,
 *                             matching VERIFIER_PROVIDER's default)
 */

const DIST = path.join(__dirname, '..', 'dist');
const {
  verifyMcqAnswerPrompt,
  parseVerifierVerdict,
} = require(path.join(DIST, 'ai-assessment/system_prompts/system_prompts'));

/**
 * Plain arithmetic on purpose. A verifier that gets these wrong is not a
 * marginal call about a hard question, it is a broken integration.
 */
const ARITHMETIC = {
  question: 'What is 12 multiplied by 12?',
  options: { 1: '144', 2: '121', 3: '132', 4: '156' },
};

const CASES = [
  {
    name: 'keyed correctly',
    ...ARITHMETIC,
    keyed: 1,
    expect: 'agree',
  },
  {
    name: 'keyed wrongly',
    ...ARITHMETIC,
    keyed: 4,
    expect: 'disagree',
  },
  {
    name: 'right answer absent from the options',
    question: ARITHMETIC.question,
    options: { 1: '121', 2: '132', 3: '156', 4: '169' },
    keyed: 1,
    expect: 'none',
  },
  {
    name: 'on topic, when a topic is supplied',
    ...ARITHMETIC,
    keyed: 1,
    topic: { name: 'Basic Arithmetic', subtopics: ['multiplication'] },
    expect: 'agree',
  },
  {
    name: 'belongs to a different subject than the topic asked for',
    ...ARITHMETIC,
    keyed: 1,
    topic: { name: 'Photosynthesis', subtopics: ['chlorophyll', 'light reactions'] },
    expect: 'off-topic',
  },
];

function parseArgs(argv) {
  const opts = { confirmed: false, provider: 'genai' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') opts.confirmed = true;
    else if (arg === '--provider') opts.provider = String(argv[++i]).toLowerCase();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['genai', 'openai'].includes(opts.provider)) {
    throw new Error('--provider must be genai or openai');
  }
  return opts;
}

function buildProvider(which) {
  if (which === 'genai') {
    if (!process.env.GOOGLE_GENAI_API_KEY) {
      throw new Error('GOOGLE_GENAI_API_KEY is not set');
    }
    const { GenAIProvider } = require(path.join(DIST, 'llm/providers/genai'));
    return {
      label: `genai (${process.env.GEMINI_MODEL || 'gemini-2.5-flash'})`,
      instance: new GenAIProvider(),
    };
  }
  if (!process.env.OPENAI_KEY) {
    throw new Error('OPENAI_KEY is not set');
  }
  const { OpenAIProvider } = require(path.join(DIST, 'llm/providers/openai'));
  return { label: 'openai (gpt-4.1)', instance: new OpenAIProvider() };
}

/**
 * What QuestionsProcessor would do with this verdict.
 *
 * Order matters and mirrors verifyKeyedAnswers: the answer decides first, and
 * relevance is only consulted for a question whose answer already checks out.
 * A question that is both wrongly keyed and off topic is reported as wrongly
 * keyed, because that is the reason the log would carry.
 */
function classify(verdict, keyed) {
  if (!verdict) return 'unreadable';
  if (verdict.correctOption === null) return 'none';
  if (verdict.correctOption !== keyed) return 'disagree';
  if (verdict.onTopic === false) return 'off-topic';
  return 'agree';
}

async function main(confirmed, opts) {
  console.log(`provider: ${opts.provider}`);
  console.log(`cases: ${CASES.length}`);

  if (!confirmed) {
    console.log('');
    console.log('--- prompt for case 1 (offline preview) ---');
    console.log(verifyMcqAnswerPrompt({ question: CASES[0].question, options: CASES[0].options }));
    console.log('');
    console.log('Dry run: no LLM call made. Re-run with --confirm to send them.');
    console.log('  node scripts/preflight-verifier.js --confirm');
    return;
  }

  const provider = buildProvider(opts.provider);
  console.log(`model: ${provider.label}`);
  console.log('');

  let allOk = true;

  for (const testCase of CASES) {
    const prompt = verifyMcqAnswerPrompt({
      question: testCase.question,
      options: testCase.options,
      topic: testCase.topic,
    });

    let raw = null;
    let error = null;
    try {
      const res = await provider.instance.completion(prompt);
      raw = res?.text ?? null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const verdict = parseVerifierVerdict(raw);
    const actual = error ? 'unreadable' : classify(verdict, testCase.keyed);
    const ok = actual === testCase.expect;
    if (!ok) allOk = false;

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.name}`);
    console.log(`        keyed option ${testCase.keyed}, expected "${testCase.expect}", got "${actual}"`);
    if (error) {
      console.log(`        provider error: ${error}`);
    } else if (!verdict) {
      console.log(`        reply could not be parsed. First 200 chars:`);
      console.log(`        ${String(raw).slice(0, 200).replace(/\n/g, ' ')}`);
    } else {
      console.log(
        `        verifier answered option ${verdict.correctOption === null ? 'null (none fit)' : verdict.correctOption}` +
          ` computed=${JSON.stringify(verdict.computedAnswer)}` +
          (testCase.topic ? ` onTopic=${verdict.onTopic} difficulty=${verdict.difficulty}` : ''),
      );
    }
    console.log('');
  }

  if (allOk) {
    console.log('Verification works on this provider: agreement, disagreement and');
    console.log('"none of these fit" are all read correctly. Safe to leave');
    console.log(`VERIFIER_PROVIDER=${opts.provider}.`);
    return;
  }

  console.log('This provider is NOT safe to verify with as configured.');
  console.log('An unreadable reply makes every question "kept unverified", so');
  console.log('verification would be switched on and doing nothing. Either fix');
  console.log('the cause above or set VERIFIER_PROVIDER to the other provider.');
  process.exitCode = 1;
}

// Only runs when invoked directly, never on require.
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

module.exports = { main, CASES, classify };
