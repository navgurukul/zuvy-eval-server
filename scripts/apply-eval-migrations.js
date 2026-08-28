require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ALLOWLIST = [
  'levels',
  'questions_by_llm',
  'zuvy_questions',
  'topic',
  'ai_assessment',
  'mcq_question_options',
  'correct_answers',
  'question_level_relation',
  'zuvy_question_explanations',
  'question_index_outbox',
  'ai_assessment_question_sets',
  'ai_assessment_questions',
  'student_assessment',
  'student_answers',
  'student_level_relation',
  'question_evaluation',
  'question_student_answer_relation',
  'llm_usage',
];

const PARENT = [
  'users',
  'zuvy_bootcamps',
  'zuvy_module_chapter',
  'zuvy_course_modules',
];

const MIGRATION_FILE = '001_eval_tables.sql';

function targetSchema() {
  return process.env.ENV_NOTE === 'stage' ? 'stage' : 'main';
}

function splitStatements(sql) {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length && !s.split('\n').every((line) => line.trim().startsWith('--')));
}

function assertSqlSafe(sql, schema) {
  if (sql.includes('__SCHEMA__')) {
    throw new Error('SQL still contains __SCHEMA__ placeholder');
  }
  const forbidden = sql.match(
    /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE|DELETE\s+FROM|UPDATE\s+|GRANT\s+|REVOKE\s+|ALTER\s+TABLE)\b/gi,
  );
  if (forbidden) {
    throw new Error(`SQL contains forbidden keyword: ${forbidden.join(', ')}`);
  }
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+"([^"]+)"\."([^"]+)"/g)];
  for (const [, sch, name] of tables) {
    if (sch !== schema) {
      throw new Error(`CREATE TABLE targets schema ${sch}, expected ${schema}`);
    }
    if (!ALLOWLIST.includes(name)) {
      throw new Error(`Refusing to create non-eval table ${sch}.${name}`);
    }
  }
  if (tables.length !== ALLOWLIST.length) {
    throw new Error(
      `Expected ${ALLOWLIST.length} CREATE TABLE statements, found ${tables.length}`,
    );
  }
}

async function counts(client, schema, names) {
  const out = {};
  for (const name of names) {
    const exists = await client.query(
      `SELECT to_regclass($1) AS reg`,
      [`${schema}.${name}`],
    );
    if (!exists.rows[0].reg) {
      out[`${schema}.${name}`] = null;
      continue;
    }
    const r = await client.query(`SELECT count(*)::bigint AS n FROM ${quote(schema)}.${quote(name)}`);
    out[`${schema}.${name}`] = r.rows[0].n;
  }
  return out;
}

function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function main() {
  const schema = targetSchema();
  const dbName = process.env.DB_NAME;

  if (!['stage', 'main'].includes(schema)) {
    throw new Error(`Refusing unknown schema ${schema}`);
  }
  if (schema === 'main' && dbName === 'dev' && process.env.FORCE_EVAL_MAIN_ON_DEV !== '1') {
    throw new Error(
      'Refusing to apply eval DDL to schema "main" on database "dev". Set ENV_NOTE=stage for staging, or FORCE_EVAL_MAIN_ON_DEV=1 only if you intend to no-op against existing main tables.',
    );
  }

  const file = path.join(__dirname, '..', 'migrations', MIGRATION_FILE);
  const raw = fs.readFileSync(file, 'utf8');
  const sql = raw.replaceAll('"__SCHEMA__"', `"${schema}"`).replaceAll('__SCHEMA__', schema);
  assertSqlSafe(sql, schema);

  const client = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 5432),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`Applying ${MIGRATION_FILE} to schema "${schema}" on database "${dbName}"`);

  const beforeMainEval = await counts(client, 'main', ALLOWLIST);
  const beforeStageParent = await counts(client, schema === 'stage' ? 'stage' : 'main', PARENT);

  await client.query('BEGIN');
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${quote(schema)}.eval_schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const already = await client.query(
      `SELECT 1 FROM ${quote(schema)}.eval_schema_migrations WHERE filename = $1`,
      [MIGRATION_FILE],
    );
    if (already.rowCount) {
      console.log(`${MIGRATION_FILE} already recorded for schema ${schema}; skipping`);
      await client.query('COMMIT');
      await client.end();
      return;
    }

    for (const stmt of splitStatements(sql)) {
      await client.query(stmt);
    }

    await client.query(
      `INSERT INTO ${quote(schema)}.eval_schema_migrations (filename) VALUES ($1)`,
      [MIGRATION_FILE],
    );

    const afterMainEval = await counts(client, 'main', ALLOWLIST);
    const parentSchema = schema === 'stage' ? 'stage' : 'main';
    const afterParent = await counts(client, parentSchema, PARENT);
    const afterTargetEval = await counts(client, schema, ALLOWLIST);

    const changedMain = ALLOWLIST.filter(
      (t) => String(beforeMainEval[`main.${t}`]) !== String(afterMainEval[`main.${t}`]),
    );
    if (schema === 'stage' && changedMain.length) {
      throw new Error(`main eval row counts changed: ${changedMain.join(', ')}`);
    }
    const changedParent = PARENT.filter(
      (t) =>
        String(beforeStageParent[`${parentSchema}.${t}`]) !==
        String(afterParent[`${parentSchema}.${t}`]),
    );
    if (changedParent.length) {
      throw new Error(`parent table counts changed: ${changedParent.join(', ')}`);
    }

    await client.query('COMMIT');
    console.log('parent counts (unchanged):', afterParent);
    console.log('target eval counts:', afterTargetEval);
    console.log('main eval counts (must be unchanged when targeting stage):', afterMainEval);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
