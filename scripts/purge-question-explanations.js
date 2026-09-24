require('dotenv').config();
const { Client } = require('pg');

/**
 * One-off purge of cached MCQ explanations.
 *
 * zuvy_question_explanations is a cache keyed on question id with no
 * invalidation. Rows generated before the explanation prompt was fixed can
 * state one option number, argue for another, and append a "Correction:"
 * block, and every student who opens that question is served the same row
 * forever. Deleting them is safe and recoverable: the next request per
 * question regenerates the explanation under the current prompt, which is
 * validated against the stored answer before it is cached.
 *
 * This is deliberately NOT a migration. apply-eval-migrations.js enforces that
 * migrations never change row counts, and that invariant is worth keeping
 * unconditional, so a data purge belongs in a script you run on purpose.
 *
 * Usage:
 *   node scripts/purge-question-explanations.js             # dry run, counts only
 *   node scripts/purge-question-explanations.js --confirm   # actually delete
 *
 * Targets the same schema as the migration runner: "stage_template" when
 * ENV_NOTE=stage_template, otherwise "main".
 */

const TABLE = 'zuvy_question_explanations';

function targetSchema() {
  return process.env.ENV_NOTE === 'stage_template' ? 'stage_template' : 'main';
}

function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * @param {boolean} confirmed - true deletes, false counts and reports only.
 *   Passed in rather than read from process.argv here, so importing this module
 *   and calling main() can never pick up a stray --confirm from the host
 *   process's own arguments.
 */
async function main(confirmed = false) {
  const schema = targetSchema();
  if (!['stage_template', 'main'].includes(schema)) {
    throw new Error(`Refusing unknown schema ${schema}`);
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

  try {
    const target = `${quote(schema)}.${quote(TABLE)}`;

    const exists = await client.query('SELECT to_regclass($1) AS reg', [
      `${schema}.${TABLE}`,
    ]);
    if (!exists.rows[0].reg) {
      throw new Error(`${schema}.${TABLE} does not exist on database "${process.env.DB_NAME}"`);
    }

    const before = await client.query(`SELECT count(*)::int AS n FROM ${target}`);
    const rows = before.rows[0].n;

    console.log(`database: ${process.env.DB_NAME}   schema: ${schema}`);
    console.log(`${schema}.${TABLE} holds ${rows} cached explanation(s).`);

    if (!confirmed) {
      console.log('');
      console.log('Dry run: nothing deleted.');
      console.log('Re-run with --confirm to delete them:');
      console.log('  node scripts/purge-question-explanations.js --confirm');
      return;
    }

    if (rows === 0) {
      console.log('Nothing to purge.');
      return;
    }

    const result = await client.query(`DELETE FROM ${target}`);
    console.log(`Deleted ${result.rowCount} row(s) from ${schema}.${TABLE}.`);
    console.log(
      'Explanations regenerate on demand and are validated against the stored answer before caching.',
    );
  } finally {
    await client.end();
  }
}

// Only runs when invoked directly, never on require. This is the one place
// process.argv is read.
if (require.main === module) {
  const confirmed = process.argv.slice(2).includes('--confirm');
  main(confirmed).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main, targetSchema, TABLE };
