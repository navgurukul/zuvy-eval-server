require('dotenv').config();
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

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 5432),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const r = await client.query(
    `
    SELECT n.nspname AS schema,
           c.relname AS name,
           c.relkind,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('main', 'stage')
      AND c.relname = ANY($1)
      AND c.relkind IN ('r', 'S')
    ORDER BY n.nspname, c.relkind, c.relname
    `,
    [ALLOWLIST],
  );
  console.table(r.rows);

  const tables = (schema) =>
    r.rows.filter((x) => x.schema === schema && x.relkind === 'r').map((x) => x.name);

  const mainTables = tables('main');
  const stageTables = tables('stage');
  console.log('missing in main:', ALLOWLIST.filter((t) => !mainTables.includes(t)));
  console.log('already in stage:', stageTables);
  console.log('missing in stage:', ALLOWLIST.filter((t) => !stageTables.includes(t)));

  const enums = await client.query(`
    SELECT n.nspname AS schema, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname IN ('assessment_scope', 'assessment_status')
    ORDER BY 1, 2
  `);
  console.log('enums:', enums.rows);

  const parent = await client.query(
    `
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('main', 'stage')
      AND c.relkind = 'r'
      AND c.relname = ANY($1)
    ORDER BY 1, 2
    `,
    [PARENT],
  );
  console.log(
    'parent tables:',
    parent.rows.map((x) => `${x.schema}.${x.name}`),
  );

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
