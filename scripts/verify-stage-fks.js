require('dotenv').config();
const { Client } = require('pg');

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
  const fks = await client.query(`
    SELECT
      n.nspname AS from_schema,
      c.relname AS from_table,
      nf.nspname AS to_schema,
      cf.relname AS to_table,
      con.conname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class cf ON cf.oid = con.confrelid
    JOIN pg_namespace nf ON nf.oid = cf.relnamespace
    WHERE con.contype = 'f'
      AND n.nspname = 'stage'
      AND c.relname = ANY($1)
    ORDER BY 2, 5
  `, [[
    'levels','questions_by_llm','zuvy_questions','topic','ai_assessment',
    'mcq_question_options','correct_answers','question_level_relation',
    'zuvy_question_explanations','question_index_outbox',
    'ai_assessment_question_sets','ai_assessment_questions',
    'student_assessment','student_answers','student_level_relation',
    'question_evaluation','question_student_answer_relation','llm_usage',
  ]]);
  const bad = fks.rows.filter((r) => r.to_schema !== 'stage');
  console.log('stage eval FKs:', fks.rows.length);
  console.log('FKs pointing outside stage:', bad);
  const extra = await client.query(`
    SELECT relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'stage' AND c.relkind = 'r'
      AND relname LIKE 'eval%'
    ORDER BY 1
  `);
  console.log('eval bookkeeping tables in stage:', extra.rows);
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
