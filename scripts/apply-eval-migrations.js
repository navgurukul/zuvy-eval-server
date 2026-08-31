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

function shouldSkipMigrations() {
  const value = String(process.env.SKIP_EVAL_MIGRATIONS || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function targetSchema() {
  return process.env.ENV_NOTE === 'stage' ? 'stage' : 'main';
}

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((filename) => ({
      filename,
      raw: fs.readFileSync(path.join(dir, filename), 'utf8'),
    }));
}

function stripCommentLines(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

function splitStatements(sql) {
  return stripCommentLines(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function substituteSchema(raw, schema) {
  return raw.replaceAll('"__SCHEMA__"', `"${schema}"`).replaceAll('__SCHEMA__', schema);
}

function assertSqlSafe(sql, schema, filename) {
  if (sql.includes('__SCHEMA__')) {
    throw new Error(`${filename} still contains __SCHEMA__ placeholder`);
  }
  const forbidden = sql.match(
    /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE|DELETE\s+FROM|UPDATE\s+|GRANT\s+|REVOKE\s+)\b/gi,
  );
  if (forbidden) {
    throw new Error(`${filename} contains forbidden keyword: ${forbidden.join(', ')}`);
  }

  if (filename.startsWith('001_')) {
    const alter = sql.match(/\bALTER\s+TABLE\b/gi);
    if (alter) {
      throw new Error(`${filename} must not ALTER TABLE`);
    }
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+"([^"]+)"\."([^"]+)"/g)];
    for (const [, sch, name] of tables) {
      if (sch !== schema) {
        throw new Error(`${filename} CREATE TABLE targets schema ${sch}, expected ${schema}`);
      }
      if (!ALLOWLIST.includes(name)) {
        throw new Error(`Refusing to create non-eval table ${sch}.${name}`);
      }
    }
    if (tables.length !== ALLOWLIST.length) {
      throw new Error(
        `${filename}: expected ${ALLOWLIST.length} CREATE TABLE statements, found ${tables.length}`,
      );
    }
    return;
  }

  for (const stmt of splitStatements(sql)) {
    const m = normalize(stmt).match(
      /^ALTER TABLE "([^"]+)"\."([^"]+)" ALTER COLUMN "([^"]+)" DROP NOT NULL$/i,
    );
    if (!m) {
      throw new Error(`Refusing statement in ${filename}: ${stmt}`);
    }
    if (m[1] !== schema) {
      throw new Error(`${filename} ALTER targets schema ${m[1]}, expected ${schema}`);
    }
    if (!ALLOWLIST.includes(m[2])) {
      throw new Error(`Refusing ALTER on non-eval table ${m[1]}.${m[2]}`);
    }
  }
}

async function counts(client, schema, names) {
  const out = {};
  for (const name of names) {
    const exists = await client.query(`SELECT to_regclass($1) AS reg`, [`${schema}.${name}`]);
    if (!exists.rows[0].reg) {
      out[`${schema}.${name}`] = null;
      continue;
    }
    const r = await client.query(
      `SELECT count(*)::bigint AS n FROM ${quote(schema)}.${quote(name)}`,
    );
    out[`${schema}.${name}`] = r.rows[0].n;
  }
  return out;
}

function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function allAllowlistedExist(client, schema) {
  const r = await client.query(
    `
    SELECT count(*)::int AS n
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
      AND c.relkind = 'r'
      AND c.relname = ANY($2)
    `,
    [schema, ALLOWLIST],
  );
  return r.rows[0].n === ALLOWLIST.length;
}

async function main() {
  if (shouldSkipMigrations()) {
    console.log('SKIP_EVAL_MIGRATIONS is set; not applying migrations');
    return;
  }

  const schema = targetSchema();
  const dbName = process.env.DB_NAME;

  if (!['stage', 'main'].includes(schema)) {
    throw new Error(`Refusing unknown schema ${schema}`);
  }

  const files = migrationFiles();
  if (!files.length) {
    throw new Error('No migration files found');
  }

  const client = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 5432),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`Applying eval migrations to schema "${schema}" on database "${dbName}"`);

  const beforeMainEval = await counts(client, 'main', ALLOWLIST);
  const parentSchema = schema === 'stage' ? 'stage' : 'main';
  const beforeParent = await counts(client, parentSchema, PARENT);

  await client.query('BEGIN');
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${quote(schema)}.eval_schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query(
      `SELECT filename FROM ${quote(schema)}.eval_schema_migrations`,
    );
    const done = new Set(applied.rows.map((r) => r.filename));

    for (const file of files) {
      if (done.has(file.filename)) {
        console.log(`${file.filename} already recorded for schema ${schema}; skipping`);
        continue;
      }

      if (file.filename.startsWith('001_')) {
        const exists = await allAllowlistedExist(client, schema);
        if (exists) {
          await client.query(
            `INSERT INTO ${quote(schema)}.eval_schema_migrations (filename) VALUES ($1)`,
            [file.filename],
          );
          console.log(
            `${file.filename} baseline recorded for schema ${schema} (tables already present); not re-run`,
          );
          continue;
        }
        if (schema === 'main' && dbName === 'dev' && process.env.FORCE_EVAL_MAIN_ON_DEV !== '1') {
          throw new Error(
            'Refusing to CREATE eval tables on schema "main" in database "dev". Set ENV_NOTE=stage for staging.',
          );
        }
      }

      const sql = substituteSchema(file.raw, schema);
      assertSqlSafe(sql, schema, file.filename);

      for (const stmt of splitStatements(sql)) {
        await client.query(stmt);
      }
      await client.query(
        `INSERT INTO ${quote(schema)}.eval_schema_migrations (filename) VALUES ($1)`,
        [file.filename],
      );
      console.log(`applied ${file.filename}`);
    }

    const afterMainEval = await counts(client, 'main', ALLOWLIST);
    const afterParent = await counts(client, parentSchema, PARENT);

    const changedMain = ALLOWLIST.filter(
      (t) => String(beforeMainEval[`main.${t}`]) !== String(afterMainEval[`main.${t}`]),
    );
    if (changedMain.length) {
      throw new Error(`main eval row counts changed: ${changedMain.join(', ')}`);
    }
    const changedParent = PARENT.filter(
      (t) =>
        String(beforeParent[`${parentSchema}.${t}`]) !==
        String(afterParent[`${parentSchema}.${t}`]),
    );
    if (changedParent.length) {
      throw new Error(`parent table counts changed: ${changedParent.join(', ')}`);
    }

    await client.query('COMMIT');
    console.log('parent counts (unchanged):', afterParent);
    console.log('main eval counts (unchanged):', afterMainEval);
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
