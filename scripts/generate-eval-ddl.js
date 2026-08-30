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

const PARENT = new Set([
  'users',
  'zuvy_bootcamps',
  'zuvy_module_chapter',
  'zuvy_course_modules',
  'zuvy_organizations',
  'zuvy_batch_enrollments',
]);

const KNOWN_TABLES = new Set([...ALLOWLIST, ...PARENT]);

function qIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function qualify(sql) {
  return sql
    .replace(/"main"\./g, '"__SCHEMA__".')
    .replace(/\bmain\./g, '"__SCHEMA__".')
    .replace(/nextval\('([^']+)'::regclass\)/g, (_m, seq) => {
      const bare = String(seq).replace(/^main\./, '').replace(/"/g, '');
      return `nextval('"__SCHEMA__".${qIdent(bare)}'::regclass)`;
    })
    .replace(
      /REFERENCES\s+(?!(?:"__SCHEMA__"\.|"main"\.))([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
      'REFERENCES "__SCHEMA__".$1 (',
    );
}

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

  const tables = await client.query(
    `
    SELECT c.oid, n.nspname AS schema, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'main'
      AND c.relkind = 'r'
      AND c.relname = ANY($1)
    ORDER BY array_position($1::text[], c.relname)
    `,
    [ALLOWLIST],
  );

  if (tables.rows.length !== ALLOWLIST.length) {
    throw new Error(
      `Allowlist mismatch. found=${tables.rows.map((r) => r.name).join(',')}`,
    );
  }

  const sequences = await client.query(
    `
    SELECT seq.relname AS seq_name,
           tab.relname AS table_name,
           att.attname AS column_name
    FROM pg_class seq
    JOIN pg_depend d ON d.objid = seq.oid AND d.deptype = 'a'
    JOIN pg_class tab ON d.refobjid = tab.oid
    JOIN pg_namespace n ON n.oid = tab.relnamespace
    JOIN pg_attribute att
      ON att.attrelid = tab.oid AND att.attnum = d.refobjsubid
    WHERE seq.relkind = 'S'
      AND n.nspname = 'main'
      AND tab.relname = ANY($1)
    ORDER BY tab.relname, att.attname
    `,
    [ALLOWLIST],
  );

  const unexpectedSeq = sequences.rows.filter((s) => !ALLOWLIST.includes(s.table_name));
  if (unexpectedSeq.length) {
    throw new Error(`Sequence owned by unexpected table: ${JSON.stringify(unexpectedSeq)}`);
  }

  const parts = [];
  parts.push('-- Eval-server schema only. Safe to re-run.');
  parts.push('-- Target schema is substituted for __SCHEMA__ (stage for staging, main for prod).');
  parts.push('-- Generated from live main. Do not add zuvy parent tables to this file.');
  parts.push('');

  for (const seq of sequences.rows) {
    parts.push(
      `CREATE SEQUENCE IF NOT EXISTS ${qIdent('__SCHEMA__')}.${qIdent(seq.seq_name)};`,
    );
  }
  if (sequences.rows.length) parts.push('');

  for (const table of tables.rows) {
    const cols = await client.query(
      `
      SELECT a.attname,
             a.attnotnull,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS typ,
             pg_get_expr(ad.adbin, ad.adrelid) AS def
      FROM pg_attribute a
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE a.attrelid = $1
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum
      `,
      [table.oid],
    );

    const colSql = cols.rows.map((col) => {
      let line = `  ${qIdent(col.attname)} ${qualify(col.typ)}`;
      if (col.def) line += ` DEFAULT ${qualify(col.def)}`;
      if (col.attnotnull) line += ' NOT NULL';
      return line;
    });

    const cons = await client.query(
      `
      SELECT conname, contype, pg_get_constraintdef(oid, true) AS def
      FROM pg_constraint
      WHERE conrelid = $1
      ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname
      `,
      [table.oid],
    );

    for (const con of cons.rows) {
      const def = qualify(con.def);
      if (con.contype === 'f') {
        const refs = [...def.matchAll(/REFERENCES\s+"__SCHEMA__"\."?([a-zA-Z0-9_]+)"?/g)].map(
          (m) => m[1],
        );
        const unqualified = [...def.matchAll(/REFERENCES\s+([a-zA-Z0-9_]+)\s*\(/g)].map(
          (m) => m[1],
        );
        for (const refTable of [...refs, ...unqualified]) {
          if (!KNOWN_TABLES.has(refTable)) {
            throw new Error(
              `FK on ${table.name} references unexpected table ${refTable}: ${def}`,
            );
          }
        }
      }
      colSql.push(`  CONSTRAINT ${qIdent(con.conname)} ${def}`);
    }

    parts.push(
      `CREATE TABLE IF NOT EXISTS ${qIdent('__SCHEMA__')}.${qIdent(table.name)} (\n${colSql.join(',\n')}\n);`,
    );

    const indexes = await client.query(
      `
      SELECT pg_get_indexdef(ix.indexrelid) AS def
      FROM pg_index ix
      WHERE ix.indrelid = $1
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.conindid = ix.indexrelid
        )
      ORDER BY ix.indexrelid
      `,
      [table.oid],
    );
    for (const idx of indexes.rows) {
      const def = qualify(idx.def).replace(
        /^CREATE (UNIQUE )?INDEX /,
        'CREATE $1INDEX IF NOT EXISTS ',
      );
      if (/\b(main|public|stage)\./.test(def.replaceAll('"__SCHEMA__".', ''))) {
        throw new Error(`Index still references another schema: ${def}`);
      }
      parts.push(`${def};`);
    }
  }

  parts.push('');
  for (const seq of sequences.rows) {
    parts.push(
      `ALTER SEQUENCE ${qIdent('__SCHEMA__')}.${qIdent(seq.seq_name)} OWNED BY ${qIdent('__SCHEMA__')}.${qIdent(seq.table_name)}.${qIdent(seq.column_name)};`,
    );
  }

  const levels = await client.query(
    `SELECT grade, score_range, score_min, score_max, hardship, meaning FROM main.levels ORDER BY id`,
  );
  parts.push('');
  parts.push('-- Lookup seed for levels. Does not copy assessment/question/student data.');
  parts.push(
    `INSERT INTO ${qIdent('__SCHEMA__')}.${qIdent('levels')} (grade, score_range, score_min, score_max, hardship, meaning)`,
  );
  parts.push('VALUES');
  parts.push(
    levels.rows
      .map((row) => {
        const v = (x) => (x == null ? 'NULL' : `'${String(x).replace(/'/g, "''")}'`);
        return `  (${v(row.grade)}, ${v(row.score_range)}, ${row.score_min ?? 'NULL'}, ${row.score_max ?? 'NULL'}, ${v(row.hardship)}, ${v(row.meaning)})`;
      })
      .join(',\n'),
  );
  parts.push('ON CONFLICT (grade) DO NOTHING;');
  parts.push('');

  const sql = parts.join('\n');
  const forbidden = sql.match(/\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE|DELETE\s+FROM|UPDATE\s+|GRANT\s+|REVOKE\s+|ALTER\s+TABLE)\b/gi);
  if (forbidden) {
    throw new Error(`Generated SQL contains forbidden keyword: ${forbidden.join(', ')}`);
  }

  const out = path.join(__dirname, '..', 'migrations', '001_eval_tables.sql');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sql);
  console.log(`wrote ${out}`);
  console.log(`tables=${tables.rows.length} sequences=${sequences.rows.length} level_rows=${levels.rows.length}`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
