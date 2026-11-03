try {
  require('dotenv').config();
} catch {
  // Inside the container the app's env is already loaded; dotenv is optional.
}
const { Client: PgClient } = require('pg');

/**
 * Re-indexes every question into OpenSearch, so the vector store can move off
 * Qdrant entirely.
 *
 * The Qdrant free-tier cluster was suspended for inactivity. Nothing it held
 * is lost: a vector is an embedding of a question's text, and every question's
 * text is in Postgres, so the whole index can be rebuilt from there. That is
 * what this does.
 *
 * Every question, not only the ones that look unindexed. Questions indexed
 * before VECTOR_DB=dual reached Qdrant alone, yet their outbox rows say
 * "done"; and in dual mode a failed OpenSearch write was swallowed without a
 * trace. The outbox cannot say what OpenSearch is missing, so the only way to
 * be sure it is complete is to index everything. That is safe to repeat:
 * each document's id is its question id, so indexing again overwrites rather
 * than duplicates.
 *
 * It does not index anything itself. It adds one pending row per question to
 * question_index_outbox, and the running server's poller indexes them through
 * the same code path as a newly generated question - same embedding text,
 * same fields. Nothing is embedded twice by two different rules.
 *
 * It checks before it queues, and --confirm is refused unless every check
 * passes:
 *   - VECTOR_DB must be "opensearch". Under "dual" the indexer writes to Qdrant
 *     first, so with Qdrant gone every queued row would fail and use up its
 *     retries before OpenSearch was ever tried.
 *   - OpenSearch must be reachable with the instance's AWS credentials.
 *   - The "questions" index must exist, because the app deliberately never
 *     creates it, and its strict mapping must declare every field the indexer
 *     writes. A missing field fails every write.
 *
 * Touches nothing on a dry run. With --confirm it only inserts outbox rows:
 * no question, set or assessment is read for writing, changed or deleted.
 *
 * Run it inside the eval container, where the app's env is already set:
 *   docker cp scripts/reindex-questions-to-opensearch.js zuvy-eval-server:/app/scripts/
 *   docker exec zuvy-eval-server node scripts/reindex-questions-to-opensearch.js
 *   docker exec zuvy-eval-server node scripts/reindex-questions-to-opensearch.js --confirm
 *
 * Options:
 *   --org-id N   only the questions of one organisation
 *
 * Targets the same schema as the migration runner: "stage_template" when
 * ENV_NOTE=stage_template, otherwise "main".
 */

const INDEX = 'questions';
const QUESTIONS_TABLE = 'zuvy_questions';
const OUTBOX_TABLE = 'question_index_outbox';
const EMBEDDING_DIMENSION = 1536;

/** Must match question-index-outbox.processor.ts. */
const MAX_ATTEMPTS = 5;
const POLL_BATCH = 50;
const POLL_SECONDS = 5;

/**
 * Every field the indexer writes, from question-index.processor.ts. The index
 * is dynamic:strict, so a field written but not declared rejects the write.
 *
 * `topic` must be a keyword, not text: mapping filters on it with a term
 * query, and a term query against an analysed text field does not match a
 * multi-word or mixed-case topic name, so mapping would find nothing.
 */
const REQUIRED_FIELDS = [
  'questionId',
  'levelId',
  'topic',
  'difficulty',
  'topicDescription',
  'subtopics',
  'embedding',
];

function parseArgs(argv) {
  const opts = { confirmed: false, orgId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') opts.confirmed = true;
    else if (arg === '--org-id') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error('--org-id must be a positive integer');
      }
      opts.orgId = n;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * Problems with an index mapping, as sentences. Empty means usable.
 *
 * @param {Record<string, {type?: string, dimension?: number}> | undefined} properties
 */
function checkMapping(properties) {
  if (!properties || typeof properties !== 'object') {
    return ['the index has no field mapping at all'];
  }
  const problems = [];
  for (const field of REQUIRED_FIELDS) {
    if (!properties[field]) problems.push(`field "${field}" is not in the mapping`);
  }
  const embedding = properties.embedding;
  if (embedding) {
    if (embedding.type !== 'knn_vector') {
      problems.push(`"embedding" is ${embedding.type}, expected knn_vector`);
    } else if (Number(embedding.dimension) !== EMBEDDING_DIMENSION) {
      problems.push(
        `"embedding" has dimension ${embedding.dimension}, expected ${EMBEDDING_DIMENSION}`,
      );
    }
  }
  const topic = properties.topic;
  if (topic && topic.type !== 'keyword') {
    problems.push(
      `"topic" is ${topic.type}, expected keyword - topic filters would match nothing`,
    );
  }
  return problems;
}

/** Rough time for the poller to work through a number of rows. */
function estimateMinutes(rows) {
  return Math.max(1, Math.ceil(((rows / POLL_BATCH) * POLL_SECONDS) / 60));
}

function targetSchema() {
  return process.env.ENV_NOTE === 'stage_template' ? 'stage_template' : 'main';
}

function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function checkOpenSearch() {
  const result = { ok: false, lines: [], documents: null };
  const host = String(process.env.OPENSEARCH_HOST || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (!host) {
    result.lines.push('OPENSEARCH_HOST   NOT SET');
    return result;
  }
  result.lines.push(`OPENSEARCH_HOST   ${host}`);

  const { Client } = require('@opensearch-project/opensearch');
  const { AwsSigv4Signer } = require('@opensearch-project/opensearch/aws');
  const { defaultProvider } = require('@aws-sdk/credential-provider-node');

  try {
    await defaultProvider()();
    result.lines.push('AWS credentials   ok');
  } catch (err) {
    result.lines.push(`AWS credentials   FAILED: ${err.message}`);
    return result;
  }

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

  let exists = false;
  try {
    const res = await client.indices.exists({ index: INDEX });
    exists = res.body === true || res.statusCode === 200;
  } catch (err) {
    if (statusOf(err) !== 404) {
      result.lines.push(`Index "${INDEX}"    FAILED to check: ${statusOf(err) ?? ''} ${err.message}`);
      return result;
    }
  }
  if (!exists) {
    result.lines.push(
      `Index "${INDEX}"    MISSING - the app never creates it; it has to be created first`,
    );
    return result;
  }
  result.lines.push(`Index "${INDEX}"    exists`);

  try {
    const res = await client.indices.getMapping({ index: INDEX });
    const entry = Object.values(res.body ?? {})[0];
    const properties = entry?.mappings?.properties;
    const problems = checkMapping(properties);
    if (problems.length) {
      result.lines.push('Mapping           PROBLEMS:');
      problems.forEach((p) => result.lines.push(`                  - ${p}`));
      return result;
    }
    result.lines.push('Mapping           ok (every field the indexer writes is declared)');
  } catch (err) {
    result.lines.push(`Mapping           FAILED to read: ${err.message}`);
    return result;
  }

  try {
    const res = await client.count({ index: INDEX });
    result.documents = Number(res.body?.count);
  } catch {
    try {
      const res = await client.search({
        index: INDEX,
        body: { size: 0, track_total_hits: true, query: { match_all: {} } },
      });
      const total = res.body?.hits?.total;
      result.documents = Number(typeof total === 'object' ? total.value : total);
    } catch (err) {
      result.lines.push(`Documents         could not count: ${err.message}`);
    }
  }
  if (result.documents !== null && Number.isFinite(result.documents)) {
    result.lines.push(`Documents         ${result.documents}`);
  }

  result.ok = true;
  return result;
}

/**
 * @param {{confirmed: boolean, orgId: number | null}} opts - passed in rather
 *   than read from process.argv here, so importing this module and calling
 *   main() can never pick up a stray --confirm from the host process.
 */
async function main(opts) {
  const schema = targetSchema();
  if (!['stage_template', 'main'].includes(schema)) {
    throw new Error(`Refusing unknown schema ${schema}`);
  }

  console.log('=== Vector store setting ===');
  const vectorDb = String(process.env.VECTOR_DB || 'qdrant').trim().toLowerCase();
  const vectorDbOk = vectorDb === 'opensearch';
  console.log(
    `VECTOR_DB         ${vectorDb}${vectorDbOk ? '' : '  <- must be "opensearch" before --confirm'}`,
  );

  console.log('\n=== OpenSearch ===');
  const os = await checkOpenSearch();
  os.lines.forEach((l) => console.log(l));

  console.log('\n=== Postgres ===');
  const db = new PgClient({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 5432),
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    const questions = `${quote(schema)}.${quote(QUESTIONS_TABLE)}`;
    const outbox = `${quote(schema)}.${quote(OUTBOX_TABLE)}`;
    // The column is "orgId", camel case and quoted - see the zuvyQuestions
    // schema. topic uses org_id, which is easy to carry over by mistake, and
    // an unquoted orgId would be folded to orgid and not found either way.
    const where = opts.orgId ? 'WHERE "orgId" = $1' : '';
    const params = opts.orgId ? [opts.orgId] : [];

    const { rows: countRows } = await db.query(
      `SELECT count(*)::int AS n FROM ${questions} ${where}`,
      params,
    );
    const total = countRows[0].n;
    console.log(`schema            ${schema}`);
    console.log(
      `questions         ${total}${opts.orgId ? ` (org ${opts.orgId})` : ' (all organisations)'}`,
    );

    const { rows: outboxRows } = await db.query(
      `SELECT status, (attempts >= $1) AS stuck, count(*)::int AS n
         FROM ${outbox} GROUP BY 1, 2 ORDER BY 1, 2`,
      [MAX_ATTEMPTS],
    );
    console.log('outbox rows       (all organisations)');
    if (!outboxRows.length) console.log('                  none');
    outboxRows.forEach((r) =>
      console.log(
        `                  ${String(r.status).padEnd(11)} ${r.stuck ? 'out of retries' : '              '} ${r.n}`,
      ),
    );

    // Two counts side by side, deliberately not as a coverage figure.
    //
    // Deleting a question removes its row and never its document, so the
    // index keeps a document for every question ever deleted. A count equal
    // to or above the question total can therefore still be missing real
    // questions - the first run of this script reported 4433 documents for
    // 4405 questions while 381 questions sat in the outbox out of retries.
    // Only indexing everything makes coverage certain.
    if (os.ok && os.documents !== null && Number.isFinite(os.documents) && !opts.orgId) {
      console.log(
        `\nOpenSearch has ${os.documents} documents; Postgres has ${total} questions.\n` +
          `These counts cannot show coverage: deleting a question never removes its ` +
          `document, so the index also holds deleted questions. --confirm is what ` +
          `guarantees every current question is in.`,
      );
    }

    // What "finished" looks like after --confirm: nothing still waiting or
    // retryable. Rows out of retries are left behind by earlier outages and
    // are cleared as each question is indexed again.
    const waiting = outboxRows
      .filter((r) => !r.stuck && ['pending', 'processing', 'failed'].includes(r.status))
      .reduce((sum, r) => sum + r.n, 0);
    console.log(
      waiting
        ? `${waiting} outbox row(s) still waiting or retrying - indexing is still running.`
        : 'No outbox rows waiting or retrying.',
    );

    const ready = vectorDbOk && os.ok;

    if (!opts.confirmed) {
      console.log(
        `\nDry run: nothing was queued. --confirm would queue ${total} question(s) for ` +
          `indexing, about ${estimateMinutes(total)} minute(s) for the poller to finish.`,
      );
      if (!ready) {
        console.log('--confirm is refused until the problems above are fixed.');
      }
      return { queued: 0, ready };
    }

    if (!ready) {
      console.log('\nRefusing --confirm: fix the problems above first. Nothing was queued.');
      process.exitCode = 1;
      return { queued: 0, ready };
    }

    await db.query('BEGIN');
    try {
      const res = await db.query(
        `INSERT INTO ${outbox} (question_id, status, attempts)
         SELECT id, 'pending', 0 FROM ${questions} ${where}`,
        params,
      );
      await db.query('COMMIT');
      console.log(
        `\nQueued ${res.rowCount} question(s). The server's poller will index them in ` +
          `about ${estimateMinutes(res.rowCount)} minute(s). Re-run without --confirm ` +
          `afterwards to see the OpenSearch document count.`,
      );
      return { queued: res.rowCount, ready };
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  } finally {
    await db.end();
  }
}

module.exports = { parseArgs, checkMapping, estimateMinutes, REQUIRED_FIELDS };

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
