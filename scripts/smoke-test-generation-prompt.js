require('dotenv').config();
const path = require('path');
const { OpenAI } = require('openai');

/**
 * One real generation call, to prove the prompt still produces output the
 * pipeline can parse. Run this before deploying any change to
 * generateMcqPromptFromSpec.
 *
 * The prompt now asks the model to write its working into a "solution" field
 * placed before "options" and "correctOption", so it commits to an answer
 * before building options around it. That is the only change in the pipeline
 * that cannot be verified offline: if the model answers in an unexpected
 * shape, parseLlmMcq throws and every generation job fails.
 *
 * Deliberately loads the BUILT files from dist/, so it exercises exactly the
 * artifact that would be deployed. Run "npm run build" first.
 *
 * Touches no database and writes nothing. One LLM call.
 *
 * Usage:
 *   node scripts/smoke-test-generation-prompt.js            # dry run, prints the prompt
 *   node scripts/smoke-test-generation-prompt.js --confirm  # makes the call
 *
 * Options:
 *   --count N     questions to request (default 3)
 *   --topic NAME  topic to generate for (default "Time and Distance")
 *   --model NAME  model id (default gpt-4.1, matching OpenAIProvider)
 */

const DIST = path.join(__dirname, '..', 'dist');
const { generateMcqPromptFromSpec } = require(path.join(DIST, 'ai-assessment/system_prompts/system_prompts'));
const { parseLlmMcq } = require(path.join(DIST, 'llm/llm_response_parsers/mcqParser'));
const { QuestionsProcessor } = require(path.join(DIST, 'questions/questions.processor'));

const DEFAULT_MODEL = 'gpt-4.1';

function parseArgs(argv) {
  const opts = { confirmed: false, count: 3, topic: 'Time and Distance', model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') opts.confirmed = true;
    else if (arg === '--count') opts.count = Number(argv[++i]);
    else if (arg === '--topic') opts.topic = String(argv[++i]);
    else if (arg === '--model') opts.model = String(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 10) {
    throw new Error('--count must be between 1 and 10');
  }
  return opts;
}

/** A quantitative topic on purpose: that is where the disagreements cluster. */
function buildSpec(opts) {
  const easy = Math.max(1, Math.floor(opts.count / 3));
  const hard = Math.max(1, Math.floor(opts.count / 3));
  return {
    topic: opts.topic,
    topicName: opts.topic,
    topicDescription: `Problems involving speed, distance and time, including relative speed.`,
    count: opts.count,
    subtopics: ['average speed', 'relative speed'],
    targetAudience: 'undergraduate students',
    bloomsLevel: 'apply',
    batchQuestionCounts: { easy, medium: opts.count - easy - hard, hard },
  };
}

function check(label, passed, detail) {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  return passed;
}

async function main(confirmed, opts) {
  const spec = buildSpec(opts);
  const prompt = generateMcqPromptFromSpec(spec, [
    'A train covers 120 km in 2 hours. What is its average speed?',
  ]);

  console.log(`topic: ${spec.topic}   count: ${spec.count}   model: ${opts.model}`);
  console.log(`prompt length: ${prompt.length} characters`);

  const asksForSolution = prompt.includes('"solution"');
  const solutionBeforeOptions =
    prompt.indexOf('"solution"') > -1 &&
    prompt.indexOf('"solution"') < prompt.indexOf('"correctOption"');
  console.log('');
  console.log('Prompt checks (offline):');
  check('asks for a "solution" field', asksForSolution);
  check('"solution" appears before "correctOption"', solutionBeforeOptions);

  if (!confirmed) {
    console.log('');
    console.log('Dry run: no LLM call made. Re-run with --confirm to send it.');
    console.log('  node scripts/smoke-test-generation-prompt.js --confirm');
    return;
  }
  if (!process.env.OPENAI_KEY) throw new Error('OPENAI_KEY is not set');

  console.log('');
  console.log('Calling the model once...');
  const ai = new OpenAI({ apiKey: process.env.OPENAI_KEY, timeout: 180000, maxRetries: 1 });
  const res = await ai.responses.create({
    model: opts.model,
    input: prompt,
    temperature: 0.3,
    top_p: 0.9,
  });
  const raw = res.output_text;
  console.log(`response: ${raw ? raw.length + ' characters' : 'EMPTY'}`);

  console.log('');
  console.log('Pipeline checks:');
  let allOk = true;

  let parsed;
  try {
    parsed = parseLlmMcq(raw);
    allOk = check('parseLlmMcq accepts the response', true) && allOk;
  } catch (err) {
    check('parseLlmMcq accepts the response', false, String(err.message).slice(0, 120));
    console.log('');
    console.log('--- raw response (first 600 chars) ---');
    console.log(String(raw).slice(0, 600));
    console.log('');
    console.log('The prompt change is NOT safe to deploy: generation would fail.');
    process.exitCode = 1;
    return;
  }

  const items = parsed.evaluations ?? [];
  allOk = check(`returned exactly ${spec.count} questions`, items.length === spec.count, `got ${items.length}`) && allOk;

  const withSolution = items.filter((q) => q.solution && String(q.solution).trim());
  allOk = check(
    'every question carries written working',
    withSolution.length === items.length,
    `${withSolution.length}/${items.length}`,
  ) && allOk;

  // The structural validation that now gates the real pipeline.
  const processor = new QuestionsProcessor(null, null, null, null);
  processor.logger = { warn: (m) => console.log('   WARN ' + m), log: () => {}, error: () => {}, debug: () => {} };
  try {
    processor.assertWellFormedMcqs(items, 'smoke-test');
    allOk = check('assertWellFormedMcqs accepts the batch', true) && allOk;
  } catch (err) {
    allOk = check('assertWellFormedMcqs accepts the batch', false, String(err.message).slice(0, 140)) && allOk;
  }

  console.log('');
  console.log('--- sample question ---');
  const s = items[0];
  if (s) {
    console.log(`Q: ${s.question}`);
    console.log(`solution: ${String(s.solution ?? '(none)').slice(0, 200)}`);
    Object.entries(s.options || {}).forEach(([k, v]) => {
      console.log(`  ${k}. ${v}${Number(k) === Number(s.correctOption) ? '   <- keyed correct' : ''}`);
    });
  }

  console.log('');
  console.log(
    allOk
      ? 'Prompt change looks safe to deploy: the pipeline parses and validates this output.'
      : 'One or more checks failed. Do NOT deploy the prompt change until resolved.',
  );
  if (!allOk) process.exitCode = 1;
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

module.exports = { main, buildSpec };
