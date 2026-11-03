try {
  require('dotenv').config();
} catch {
  // Inside the container the app's env is already loaded; dotenv is optional.
}
const {
  checkMapping,
  questionsIndexName,
} = require('./reindex-questions-to-opensearch');

/**
 * Creates this environment's questions index by copying another index's
 * definition - for giving stage its own index on the collection dev uses.
 *
 * Dev and stage share one OpenSearch collection. Each question is stored under
 * its own id, and stage's questions are numbered from 1 just like dev's, so a
 * shared index would let them overwrite each other. OPENSEARCH_INDEX_PREFIX
 * gives each environment its own index, but the app never creates one: the
 * store refuses to, because the mapping is strict and has to be right before
 * the first write.
 *
 * So this copies the mapping of an index that already works - dev's
 * "questions" - rather than writing one out by hand. The two then cannot
 * differ: every field the indexer writes, its type, and the vector settings
 * (engine, distance, dimension) come across exactly as they are.
 *
 * Checks before it creates anything, and refuses --confirm unless all of it
 * passes:
 *   - OPENSEARCH_INDEX_PREFIX must be set. Without it the target is dev's own
 *     "questions" index.
 *   - The source index must exist and declare every field the indexer writes.
 *   - The target must not exist yet. This never replaces or changes an index.
 *
 * Reads only on a dry run. With --confirm it creates one empty index and
 * touches nothing else; the reindex script fills it afterwards.
 *
 * Run it inside the stage container, after OPENSEARCH_INDEX_PREFIX=stage_ is in
 * .env.stage and the container has been recreated:
 *   docker cp scripts/create-opensearch-index.js zuvy-eval-server-stage:/app/scripts/
 *   docker cp scripts/reindex-questions-to-opensearch.js zuvy-eval-server-stage:/app/scripts/
 *   docker exec zuvy-eval-server-stage node scripts/create-opensearch-index.js
 *   docker exec zuvy-eval-server-stage node scripts/create-opensearch-index.js --confirm
 *
 * Options:
 *   --from NAME   the index to copy (default: questions, dev's index)
 */

const DEFAULT_SOURCE = 'questions';

function parseArgs(argv) {
  const opts = { confirmed: false, from: DEFAULT_SOURCE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') opts.confirmed = true;
    else if (arg === '--from') {
      const name = String(argv[++i] ?? '').trim();
      if (!name) throw new Error('--from needs an index name');
      opts.from = name;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * Which index would be created, or why not. Pure, so the rules can be checked
 * without an OpenSearch to run against.
 *
 * @returns {{ target: string | null, refusal: string | null }}
 */
function planIndexCreation({ prefixSetting, from }) {
  let target;
  try {
    target = questionsIndexName(prefixSetting);
  } catch (err) {
    return { target: null, refusal: err.message };
  }
  if (!String(prefixSetting ?? '').trim()) {
    return {
      target,
      refusal:
        'OPENSEARCH_INDEX_PREFIX is not set here, so the target would be dev\'s own ' +
        '"questions" index. Set it in this environment\'s env file (stage uses stage_) ' +
        'and recreate the container first.',
    };
  }
  if (target === from) {
    return { target, refusal: `the target "${target}" is the index being copied` };
  }
  return { target, refusal: null };
}

/**
 * Only the k-NN settings are copied. The rest of an index's settings are
 * managed by the serverless collection, and sending them back is refused.
 */
function knnSettingsFrom(flatSettings) {
  const out = {};
  for (const [key, value] of Object.entries(flatSettings ?? {})) {
    if (key === 'index.knn' || key.startsWith('index.knn.')) out[key] = value;
  }
  if (!('index.knn' in out)) out['index.knn'] = true;
  return out;
}

async function main(opts) {
  const plan = planIndexCreation({
    prefixSetting: process.env.OPENSEARCH_INDEX_PREFIX,
    from: opts.from,
  });
  console.log(`copy from        ${opts.from}`);
  console.log(`create           ${plan.target ?? '(none)'}`);
  if (plan.refusal) {
    console.log(`\nRefusing: ${plan.refusal}. Nothing was created.`);
    process.exitCode = 1;
    return { created: false };
  }

  const host = String(process.env.OPENSEARCH_HOST || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (!host) {
    console.log('\nRefusing: OPENSEARCH_HOST is not set. Nothing was created.');
    process.exitCode = 1;
    return { created: false };
  }
  console.log(`collection       ${host}`);

  const { Client } = require('@opensearch-project/opensearch');
  const { AwsSigv4Signer } = require('@opensearch-project/opensearch/aws');
  const { defaultProvider } = require('@aws-sdk/credential-provider-node');

  const client = new Client({
    ...AwsSigv4Signer({
      region: process.env.AWS_REGION || 'ap-south-1',
      service: 'aoss',
      getCredentials: () => defaultProvider()(),
    }),
    node: `https://${host}`,
    requestTimeout: 30000,
  });
  const statusOf = (err) => err?.meta?.statusCode ?? err?.statusCode;
  const exists = async (index) => {
    try {
      const res = await client.indices.exists({ index });
      return res.body === true || res.statusCode === 200;
    } catch (err) {
      if (statusOf(err) === 404) return false;
      throw err;
    }
  };

  if (!(await exists(opts.from))) {
    console.log(`\nRefusing: the index to copy, "${opts.from}", does not exist. Nothing was created.`);
    process.exitCode = 1;
    return { created: false };
  }

  const mappingRes = await client.indices.getMapping({ index: opts.from });
  const mappings = Object.values(mappingRes.body ?? {})[0]?.mappings;
  const problems = checkMapping(mappings?.properties);
  if (problems.length) {
    console.log(`\nRefusing: "${opts.from}" is not a usable model:`);
    problems.forEach((p) => console.log(`  - ${p}`));
    console.log('Nothing was created.');
    process.exitCode = 1;
    return { created: false };
  }
  console.log(
    `fields           ${Object.keys(mappings.properties).sort().join(', ')}`,
  );

  let settings = { 'index.knn': true };
  try {
    const res = await client.indices.getSettings({
      index: opts.from,
      flat_settings: true,
    });
    settings = knnSettingsFrom(Object.values(res.body ?? {})[0]?.settings);
  } catch {
    // Not every collection exposes settings; k-NN on is what the mapping needs.
  }
  console.log(`settings         ${JSON.stringify(settings)}`);

  if (await exists(plan.target)) {
    console.log(
      `\n"${plan.target}" already exists, so there is nothing to create. ` +
        'Run the reindex script next.',
    );
    return { created: false };
  }

  if (!opts.confirmed) {
    console.log(
      `\nDry run: nothing was created. --confirm would create "${plan.target}" ` +
        `empty, with the mapping above.`,
    );
    return { created: false };
  }

  try {
    await client.indices.create({
      index: plan.target,
      body: { settings, mappings },
    });
  } catch (err) {
    const status = statusOf(err);
    console.log(
      `\nCreating "${plan.target}" failed${status ? ` (${status})` : ''}: ${err.message}`,
    );
    if (status === 403) {
      console.log(
        'A 403 means the collection\'s data access policy does not let this ' +
          'instance create that index. Allow CreateIndex, ReadDocument and ' +
          `WriteDocument on index/<collection>/${plan.target} (or index/<collection>/*) ` +
          'in the OpenSearch Serverless console, then run this again.',
      );
    }
    process.exitCode = 1;
    return { created: false };
  }

  console.log(
    `\nCreated "${plan.target}". Next: run the reindex script in this container ` +
      'to fill it from Postgres.',
  );
  return { created: true };
}

module.exports = { parseArgs, planIndexCreation, knnSettingsFrom };

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  main(opts).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
