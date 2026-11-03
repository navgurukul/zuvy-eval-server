-- =============================================================================
-- stage_template: PREVIEW - what align_eval_schema.sql would find
-- =============================================================================
--
-- Reads only. Changes nothing. Run this first, against the stage database.
--
-- Every result below is about the stage_template schema; main is never read.
-- If query 0 says true, every row of query 1 says "ok", query 2 returns no
-- rows, query 3 shows a validated key for both columns and query 4 shows 0 for
-- both tables, then align_eval_schema.sql has nothing to do.
--
-- Run with psql, for example:
--   psql "host=<stage db host> dbname=<db> user=<user> sslmode=require" \
--        -f stage_template/align_eval_schema.preview.sql
-- or open it in your SQL client and run it.
-- =============================================================================


-- 0. The organisations table the foreign keys point at. If this is false,
--    stop: queries 3 and 4 will fail, and align_eval_schema.sql refuses to run.
SELECT to_regclass('stage_template.zuvy_organizations') IS NOT NULL
  AS organisations_table_exists;


-- 1. Each column the code expects, its type on stage now, and what it should be.
--    MISSING means align_eval_schema.sql will add it.
SELECT
  v.table_name,
  v.column_name,
  coalesce(c.data_type, 'MISSING') AS current_type,
  v.expected_type,
  CASE
    WHEN c.data_type IS NULL THEN 'will be added'
    WHEN c.data_type = v.expected_type THEN 'ok'
    ELSE 'will be converted'
  END AS action
FROM (
  VALUES
    ('zuvy_questions',        'orgId',                'integer'),
    ('zuvy_questions',        'subtopics',            'jsonb'),
    ('topic',                 'org_id',               'integer'),
    ('ai_assessment',         'chapter_ids',          'jsonb'),
    ('ai_assessment',         'pool_topics',          'jsonb'),
    ('question_index_outbox', 'requested_by_user_id', 'character varying')
) AS v (table_name, column_name, expected_type)
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'stage_template'
 AND c.table_name = v.table_name
 AND c.column_name = v.column_name
ORDER BY v.table_name, v.column_name;


-- 2. Organisation values that are not whole numbers.
--    align_eval_schema.sql refuses to run while any exist, and changes nothing.
--    These would have to be corrected by hand first.
SELECT 'zuvy_questions."orgId"' AS column_name, "orgId"::text AS value, count(*) AS row_count
FROM stage_template.zuvy_questions
WHERE "orgId" IS NOT NULL
  AND "orgId"::text !~ '^\s*-?[0-9]+\s*$'
GROUP BY "orgId"
UNION ALL
SELECT 'topic.org_id', org_id::text, count(*)
FROM stage_template.topic
WHERE org_id IS NOT NULL
  AND org_id::text !~ '^\s*-?[0-9]+\s*$'
GROUP BY org_id;


-- 3. Foreign keys from these columns to zuvy_organizations already in place.
SELECT
  c.conrelid::regclass AS table_name,
  a.attname            AS column_name,
  c.conname            AS constraint_name,
  c.convalidated       AS validated
FROM pg_constraint c
JOIN pg_attribute a
  ON a.attrelid = c.conrelid
 AND a.attnum = ANY (c.conkey)
WHERE c.contype = 'f'
  AND c.connamespace = 'stage_template'::regnamespace
  AND c.confrelid = to_regclass('stage_template.zuvy_organizations')
  AND (c.conrelid, a.attname::text) IN (
        (to_regclass('stage_template.zuvy_questions')::oid, 'orgId'),
        (to_regclass('stage_template.topic')::oid, 'org_id')
      );


-- 4. Rows pointing at an organisation that does not exist.
--    These are NOT deleted. The key is still added, but left unvalidated while
--    any exist, so it guards new rows without touching old ones.
SELECT 'zuvy_questions' AS table_name, count(*) AS rows_with_unknown_org
FROM stage_template.zuvy_questions q
WHERE q."orgId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stage_template.zuvy_organizations o
    WHERE o.id = CASE WHEN trim(q."orgId"::text) ~ '^-?[0-9]{1,18}$'
                      THEN trim(q."orgId"::text)::bigint END
  )
UNION ALL
SELECT 'topic', count(*)
FROM stage_template.topic t
WHERE t.org_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stage_template.zuvy_organizations o
    WHERE o.id = CASE WHEN trim(t.org_id::text) ~ '^-?[0-9]{1,18}$'
                      THEN trim(t.org_id::text)::bigint END
  );
