-- Active: 1733738510413@@db-pg.cosodeda78lq.ap-south-1.rds.amazonaws.com@5432@dev@main
-- Recreates the three ai_assessment tables missing from schema "main".
--
-- They were dropped outside this repo: ai_assessment has a foreign key to
-- zuvy_bootcamps (a parent table this service does not own), and the other two
-- cascade off ai_assessment. A DROP CASCADE on the parent takes out exactly
-- these three and leaves the other fifteen eval tables intact.
--
-- This is NOT a migration: apply-eval-migrations.js cannot repair a missing
-- table. It skips 001 once recorded, refuses to create eval tables on main/dev
-- without FORCE_EVAL_MAIN_ON_DEV, and its row-count invariant treats a table
-- going from absent to 0 rows as a change and rolls back.
--
-- Extracted verbatim from migrations/001_eval_tables.sql with __SCHEMA__ -> main.
-- Every statement is IF NOT EXISTS, so it is safe to re-run.
--
-- Check the parent exists first:
--   SELECT to_regclass('main.zuvy_bootcamps'), to_regclass('main.ai_assessment');

BEGIN;

CREATE SEQUENCE IF NOT EXISTS "main"."ai_assessment_id_seq";
CREATE SEQUENCE IF NOT EXISTS "main"."ai_assessment_question_sets_id_seq";
CREATE SEQUENCE IF NOT EXISTS "main"."ai_assessment_questions_id_seq";

CREATE TABLE IF NOT EXISTS "main"."ai_assessment" (
  "id" integer DEFAULT nextval('"main"."ai_assessment_id_seq"'::regclass) NOT NULL,
  "bootcamp_id" integer NOT NULL,
  "title" character varying(255) NOT NULL,
  "description" text,
  "audience" jsonb,
  "total_number_of_questions" integer NOT NULL,
  "total_questions_with_buffer" integer NOT NULL,
  "start_datetime" timestamp with time zone,
  "end_datetime" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "scope" character varying(255),
  "domain_id" integer,
  "published_at" date,
  "domainId" integer,
  "chapter_id" integer,
  "status" character varying(255) DEFAULT 'draft'::character varying,
  "objective" character varying(255),
  "expected_outcomes" character varying(255),
  "chapter_ids" jsonb DEFAULT '[]'::jsonb,
  "pool_topics" jsonb DEFAULT '[]'::jsonb,
  CONSTRAINT "ai_assessment_pkey" PRIMARY KEY (id),
  CONSTRAINT "ai_assessment_bootcamp_id_fkey" FOREIGN KEY (bootcamp_id) REFERENCES "main".zuvy_bootcamps (id)
);

CREATE TABLE IF NOT EXISTS "main"."ai_assessment_question_sets" (
  "id" integer DEFAULT nextval('"main"."ai_assessment_question_sets_id_seq"'::regclass) NOT NULL,
  "ai_assessment_id" integer NOT NULL,
  "set_index" integer NOT NULL,
  "label" character varying(32) NOT NULL,
  "level_code" character varying(8),
  "status" character varying(32) DEFAULT 'draft'::character varying NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "ai_assessment_question_sets_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_ai_assessment_set_index" UNIQUE (ai_assessment_id, set_index),
  CONSTRAINT "fk_ai_assessment" FOREIGN KEY (ai_assessment_id) REFERENCES "main".ai_assessment (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "main"."ai_assessment_questions" (
  "id" integer DEFAULT nextval('"main"."ai_assessment_questions_id_seq"'::regclass) NOT NULL,
  "question_set_id" integer NOT NULL,
  "question_id" integer NOT NULL,
  "is_common" boolean DEFAULT false NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "ai_assessment_questions_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_ai_assessment_set_position" UNIQUE (question_set_id, "position"),
  CONSTRAINT "uniq_ai_assessment_set_question" UNIQUE (question_set_id, question_id),
  CONSTRAINT "fk_question" FOREIGN KEY (question_id) REFERENCES "main".zuvy_questions (id) ON DELETE CASCADE,
  CONSTRAINT "fk_question_set" FOREIGN KEY (question_set_id) REFERENCES "main".ai_assessment_question_sets (id) ON DELETE CASCADE
);

ALTER SEQUENCE "main"."ai_assessment_id_seq" OWNED BY "main"."ai_assessment"."id";
ALTER SEQUENCE "main"."ai_assessment_question_sets_id_seq" OWNED BY "main"."ai_assessment_question_sets"."id";
ALTER SEQUENCE "main"."ai_assessment_questions_id_seq" OWNED BY "main"."ai_assessment_questions"."id";

COMMIT;


SELECT n.nspname AS schema,
       c.relname AS index_name,
       t.relname AS belongs_to_table
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_index   i   ON i.indexrelid = c.oid
JOIN pg_class   t   ON t.oid = i.indrelid
WHERE c.relname IN ('ai_assessment_pkey',
                    'ai_assessment_question_sets_pkey',
                    'ai_assessment_questions_pkey');


SELECT n.nspname AS schema, c.relname AS name,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'i' THEN 'index'
                      WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view'
                      ELSE c.relkind::text END AS kind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname LIKE '%ai_assessment%'
ORDER BY 1, 3, 2;



-- exact names (yours were truncated in the grid)
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'main' AND table_name LIKE '%ai_assessment%'
ORDER BY 1;

-- do the columns match stage's copy?
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'main' AND table_name = 'zuvy_ai_assessment'
ORDER BY ordinal_position;

-- is there data in it?
SELECT count(*) FROM "main"."zuvy_ai_assessment";

SELECT 'ALTER TABLE "main"."' || table_name || '" RENAME TO "'
       || regexp_replace(table_name, '^zuvy_', '') || '";' AS stmt
FROM information_schema.tables
WHERE table_schema = 'main' AND table_name LIKE 'zuvy_ai_assessment%'
ORDER BY 1;

SELECT to_regclass('main.ai_assessment')               AS assessment,
       to_regclass('main.ai_assessment_question_sets') AS sets,
       to_regclass('main.ai_assessment_questions')     AS questions;

SELECT count(*) FROM "main"."ai_assessment";   -- expect 376



DO $$
DECLARE
  r        record;
  new_name text;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'main'
      AND tablename LIKE 'zuvy\_ai\_assessment%'
    ORDER BY tablename
  LOOP
    new_name := regexp_replace(r.tablename, '^zuvy_', '');
    EXECUTE format('ALTER TABLE main.%I RENAME TO %I', r.tablename, new_name);
    RAISE NOTICE 'renamed % -> %', r.tablename, new_name;
  END LOOP;
END $$;













