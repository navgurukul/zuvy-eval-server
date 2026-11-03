-- =============================================================================
-- stage_template: bring the eval tables in line with what the code declares
-- =============================================================================
--
-- WHY THIS FILE EXISTS
--   The dev and stage branches declare identical tables. The only schema files
--   that differ between them differ in formatting, and migrations/ is the same
--   on both, so merging dev into stage needs no schema change of its own.
--
--   Five hand-run SQL files, though, changed the database outside the
--   migration runner, and all of them were written for the main schema:
--
--     src/questions/schema/zuvy-questions-org-id.sql     "orgId" varchar -> integer, FK
--     src/topic/db/topic-org-id.sql                      org_id  varchar -> integer, FK
--     src/questions/schema/zuvy-questions-subtopics.sql  adds subtopics
--     src/questions/schema/zuvy-questions-index-outbox.sql  outbox table and column
--     main/001_add_ai_assessment_fields.sql              adds chapter_ids, pool_topics
--
--   Nothing shows they were ever run against stage_template. Migration 001
--   creates zuvy_questions."orgId" and topic.org_id as varchar, while the code
--   declares both as integer with a key to zuvy_organizations. This file does
--   for stage_template what those five did for main.
--
-- WHY THIS IS NOT A MIGRATION
--   The migration runner accepts only "ALTER COLUMN ... DROP NOT NULL" after
--   001 and refuses a type change or a foreign key. Placed in migrations/, this
--   file would be refused at container start and the app would not boot. It
--   lives here so the runner never reads it.
--
-- WHAT IT DOES NOT DO
--   It changes no existing value and deletes no row. zuvy-questions-org-id.sql
--   ends with a DELETE of every question whose organisation is missing; that
--   is left out on purpose. A row pointing at an unknown organisation is kept,
--   and its key is added unvalidated so it guards new rows only.
--
--   It only touches stage_template. Every name is schema-qualified, so even if
--   dev and stage share one database server, main is never changed.
--
-- WHAT CHANGES
--   - Missing columns are added. New jsonb columns on ai_assessment start as
--     '[]' on existing rows, exactly as on main.
--   - The two organisation columns become integer, but only if they are still
--     text, and only if every value is a whole number. Otherwise the whole
--     file stops and nothing at all is changed.
--   - A key to zuvy_organizations is added on each, ON DELETE CASCADE as on
--     main: deleting an organisation on stage then deletes its questions and
--     topics, which is how main already behaves.
--
-- HOW TO RUN
--   1. Run align_eval_schema.preview.sql first and read it.
--   2. Run this file when stage is quiet. A type change locks its table for the
--      few seconds it takes; if another session holds the lock for more than
--      10 seconds this file stops rather than wait, and changes nothing.
--   3. Run the preview again. Every row should say "ok".
--
--   psql -v ON_ERROR_STOP=1 \
--        "host=<stage db host> dbname=<db> user=<user> sslmode=require" \
--        -f stage_template/align_eval_schema.sql
--
--   Safe to run more than once: anything already in place is left alone, and
--   the NOTICE lines say what was done and what was skipped.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';


-- Additive changes. Each is a no-op when it is already in place.

CREATE TABLE IF NOT EXISTS stage_template.question_index_outbox (
  id                   SERIAL PRIMARY KEY,
  question_id          INTEGER NOT NULL,
  requested_by_user_id VARCHAR(255),
  status               VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts             INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE stage_template.question_index_outbox
  ADD COLUMN IF NOT EXISTS requested_by_user_id VARCHAR(255);

ALTER TABLE stage_template.zuvy_questions
  ADD COLUMN IF NOT EXISTS subtopics JSONB;

ALTER TABLE stage_template.ai_assessment
  ADD COLUMN IF NOT EXISTS chapter_ids JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pool_topics JSONB DEFAULT '[]'::jsonb;


-- The two organisation columns: convert, then key.

DO $align$
DECLARE
  tbl         text;
  col         text;
  fk          text;
  col_type    text;
  bad         bigint;
  unknown_org bigint;
BEGIN
  IF to_regclass('stage_template.zuvy_organizations') IS NULL THEN
    RAISE EXCEPTION
      'stage_template.zuvy_organizations does not exist, so the keys have nothing to point at. Nothing was changed.';
  END IF;

  FOR tbl, col, fk IN
    SELECT * FROM (
      VALUES
        ('zuvy_questions', 'orgId',  'zuvy_questions_org_id_fkey'),
        ('topic',          'org_id', 'topic_org_id_fkey')
    ) AS v (t, c, f)
  LOOP
    IF to_regclass(format('stage_template.%I', tbl)) IS NULL THEN
      RAISE EXCEPTION 'stage_template.% does not exist. Nothing was changed.', tbl;
    END IF;

    SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_schema = 'stage_template'
      AND table_name = tbl
      AND column_name = col;

    IF col_type IS NULL THEN
      RAISE EXCEPTION 'stage_template.%.% does not exist. Nothing was changed.', tbl, col;
    END IF;

    -- Convert only from text. Any other numeric type already holds whole
    -- numbers and is left as it is rather than narrowed.
    IF col_type IN ('character varying', 'text', 'character') THEN
      EXECUTE format(
        'SELECT count(*) FROM stage_template.%I WHERE %I IS NOT NULL AND %I !~ %L',
        tbl, col, col, '^\s*-?[0-9]+\s*$'
      ) INTO bad;

      IF bad > 0 THEN
        RAISE EXCEPTION
          '% row(s) of stage_template.% have a % that is not a whole number. Nothing was changed; the preview lists them.',
          bad, tbl, col;
      END IF;

      EXECUTE format(
        'ALTER TABLE stage_template.%I ALTER COLUMN %I TYPE integer USING %I::integer',
        tbl, col, col
      );
      RAISE NOTICE 'stage_template.%.%: % converted to integer', tbl, col, col_type;
    ELSE
      RAISE NOTICE 'stage_template.%.%: already %, left alone', tbl, col, col_type;
    END IF;

    -- Any key from this column to zuvy_organizations counts, whatever it is
    -- named, so a second, duplicate key is never added.
    IF EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND c.conrelid = to_regclass(format('stage_template.%I', tbl))
        AND c.confrelid = to_regclass('stage_template.zuvy_organizations')
        AND a.attname = col
    ) THEN
      RAISE NOTICE 'stage_template.%.%: key to zuvy_organizations already exists, left alone', tbl, col;
    ELSE
      -- NOT VALID first: the key guards every new and changed row at once,
      -- without requiring existing rows to pass, so no row has to change.
      EXECUTE format(
        'ALTER TABLE stage_template.%I ADD CONSTRAINT %I FOREIGN KEY (%I) '
          || 'REFERENCES stage_template.zuvy_organizations (id) ON DELETE CASCADE NOT VALID',
        tbl, fk, col
      );

      EXECUTE format(
        'SELECT count(*) FROM stage_template.%I t WHERE t.%I IS NOT NULL AND NOT EXISTS '
          || '(SELECT 1 FROM stage_template.zuvy_organizations o WHERE o.id = t.%I)',
        tbl, col, col
      ) INTO unknown_org;

      IF unknown_org = 0 THEN
        EXECUTE format(
          'ALTER TABLE stage_template.%I VALIDATE CONSTRAINT %I', tbl, fk
        );
        RAISE NOTICE 'stage_template.%.%: key % added and validated', tbl, col, fk;
      ELSE
        RAISE NOTICE
          'stage_template.%.%: key % added for new rows only; % existing row(s) point at an organisation that does not exist and were left exactly as they are',
          tbl, col, fk, unknown_org;
      END IF;
    END IF;
  END LOOP;
END
$align$;

COMMIT;
