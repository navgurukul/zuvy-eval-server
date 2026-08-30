-- Eval-server schema only. Safe to re-run.
-- Target schema is substituted for __SCHEMA__ (stage for staging, main for prod).
-- Generated from live main. Do not add zuvy parent tables to this file.

CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."ai_assessment_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."ai_assessment_question_sets_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."ai_assessment_questions_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."correct_answers_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."levels_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."llm_usage_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."mcq_question_options_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."question_evaluation_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."question_index_outbox_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."question_level_relation_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."question_student_answer_relation_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."questions_by_llm_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."student_answers_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."student_assessment_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."student_level_relation_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."topic_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."zuvy_question_explanations_id_seq";
CREATE SEQUENCE IF NOT EXISTS "__SCHEMA__"."zuvy_questions_id_seq";

CREATE TABLE IF NOT EXISTS "__SCHEMA__"."levels" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."levels_id_seq"'::regclass) NOT NULL,
  "grade" character varying(5) NOT NULL,
  "score_range" character varying(50) NOT NULL,
  "score_min" integer,
  "score_max" integer,
  "hardship" character varying(20),
  "meaning" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "levels_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_level_grade" UNIQUE (grade)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."questions_by_llm" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."questions_by_llm_id_seq"'::regclass) NOT NULL,
  "ai_assessment_id" integer NOT NULL,
  "topic" character varying(100),
  "difficulty" character varying(50),
  "bootcamp_id" integer,
  "question" text NOT NULL,
  "language" character varying(255),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "questions_by_llm_pkey" PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."zuvy_questions" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."zuvy_questions_id_seq"'::regclass) NOT NULL,
  "domain_name" character varying(255) NOT NULL,
  "topic_name" character varying(255) NOT NULL,
  "topic_description" text NOT NULL,
  "learning_objectives" text,
  "target_audience" character varying(255),
  "focus_areas" text,
  "blooms_level" character varying(50),
  "question_style" character varying(50),
  "question" text NOT NULL,
  "difficulty" character varying(50),
  "language" character varying(255),
  "options" jsonb NOT NULL,
  "correct_option" integer NOT NULL,
  "difficulty_distribution" jsonb,
  "question_counts" jsonb,
  "level_id" character varying(255),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "orgId" character varying(255),
  "subtopics" jsonb,
  CONSTRAINT "zuvy_questions_pkey" PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."topic" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."topic_id_seq"'::regclass) NOT NULL,
  "name" character varying(255) NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "subtopic" jsonb,
  "org_id" character varying(255),
  CONSTRAINT "topic_pkey" PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."ai_assessment" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."ai_assessment_id_seq"'::regclass) NOT NULL,
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
  CONSTRAINT "ai_assessment_bootcamp_id_fkey" FOREIGN KEY (bootcamp_id) REFERENCES "__SCHEMA__".zuvy_bootcamps (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."mcq_question_options" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."mcq_question_options_id_seq"'::regclass) NOT NULL,
  "question_id" integer NOT NULL,
  "option_text" text NOT NULL,
  "option_number" integer NOT NULL,
  CONSTRAINT "mcq_question_options_pkey" PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."correct_answers" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."correct_answers_id_seq"'::regclass) NOT NULL,
  "question_id" integer NOT NULL,
  "correct_option_id" integer NOT NULL,
  CONSTRAINT "correct_answers_pkey" PRIMARY KEY (id),
  CONSTRAINT "correct_answers_correct_option_id_fkey" FOREIGN KEY (correct_option_id) REFERENCES "__SCHEMA__".mcq_question_options (id) ON DELETE CASCADE,
  CONSTRAINT "correct_answers_question_id_fkey" FOREIGN KEY (question_id) REFERENCES "__SCHEMA__".questions_by_llm (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."question_level_relation" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."question_level_relation_id_seq"'::regclass) NOT NULL,
  "level_id" integer NOT NULL,
  "question_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "question_level_relation_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_student_question" UNIQUE (level_id, question_id),
  CONSTRAINT "question_level_relation_level_id_fkey" FOREIGN KEY (level_id) REFERENCES "__SCHEMA__".levels (id),
  CONSTRAINT "question_level_relation_question_id_fkey" FOREIGN KEY (question_id) REFERENCES "__SCHEMA__".questions_by_llm (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."zuvy_question_explanations" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."zuvy_question_explanations_id_seq"'::regclass) NOT NULL,
  "question_id" integer NOT NULL,
  "explanation" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "zuvy_question_explanations_pkey" PRIMARY KEY (id),
  CONSTRAINT "zuvy_question_explanations_question_id_key" UNIQUE (question_id),
  CONSTRAINT "fk_question_explanation" FOREIGN KEY (question_id) REFERENCES "__SCHEMA__".zuvy_questions (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."question_index_outbox" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."question_index_outbox_id_seq"'::regclass) NOT NULL,
  "question_id" integer NOT NULL,
  "status" character varying(20) DEFAULT 'pending'::character varying NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "requested_by_user_id" character varying(255),
  CONSTRAINT "question_index_outbox_pkey" PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."ai_assessment_question_sets" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."ai_assessment_question_sets_id_seq"'::regclass) NOT NULL,
  "ai_assessment_id" integer NOT NULL,
  "set_index" integer NOT NULL,
  "label" character varying(32) NOT NULL,
  "level_code" character varying(8),
  "status" character varying(32) DEFAULT 'draft'::character varying NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "ai_assessment_question_sets_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_ai_assessment_set_index" UNIQUE (ai_assessment_id, set_index),
  CONSTRAINT "fk_ai_assessment" FOREIGN KEY (ai_assessment_id) REFERENCES "__SCHEMA__".ai_assessment (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."ai_assessment_questions" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."ai_assessment_questions_id_seq"'::regclass) NOT NULL,
  "question_set_id" integer NOT NULL,
  "question_id" integer NOT NULL,
  "is_common" boolean DEFAULT false NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "ai_assessment_questions_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_ai_assessment_set_position" UNIQUE (question_set_id, "position"),
  CONSTRAINT "uniq_ai_assessment_set_question" UNIQUE (question_set_id, question_id),
  CONSTRAINT "fk_question" FOREIGN KEY (question_id) REFERENCES "__SCHEMA__".zuvy_questions (id) ON DELETE CASCADE,
  CONSTRAINT "fk_question_set" FOREIGN KEY (question_set_id) REFERENCES "__SCHEMA__".ai_assessment_question_sets (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."student_assessment" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."student_assessment_id_seq"'::regclass) NOT NULL,
  "student_id" integer NOT NULL,
  "ai_assessment_id" integer NOT NULL,
  "status" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "question_set_id" integer,
  CONSTRAINT "student_assessment_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_student_assessment" UNIQUE (student_id, ai_assessment_id),
  CONSTRAINT "student_assessment_student_id_fkey" FOREIGN KEY (student_id) REFERENCES "__SCHEMA__".users (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."student_answers" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."student_answers_id_seq"'::regclass) NOT NULL,
  "student_id" integer NOT NULL,
  "ai_assessment_id" integer NOT NULL,
  "question_id" integer NOT NULL,
  "selected_option" integer,
  "is_correct" integer DEFAULT 0 NOT NULL,
  "answered_at" timestamp with time zone DEFAULT now(),
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "student_answers_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_student_answer" UNIQUE (student_id, ai_assessment_id, question_id),
  CONSTRAINT "fk_ai_assessment" FOREIGN KEY (ai_assessment_id) REFERENCES "__SCHEMA__".ai_assessment (id) ON DELETE CASCADE,
  CONSTRAINT "fk_question" FOREIGN KEY (question_id) REFERENCES "__SCHEMA__".zuvy_questions (id) ON DELETE CASCADE,
  CONSTRAINT "fk_student" FOREIGN KEY (student_id) REFERENCES "__SCHEMA__".users (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."student_level_relation" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."student_level_relation_id_seq"'::regclass) NOT NULL,
  "student_id" integer NOT NULL,
  "level_id" integer NOT NULL,
  "ai_assessment_id" integer NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now(),
  "created_at" timestamp with time zone DEFAULT now(),
  "bootcamp_id" integer,
  CONSTRAINT "student_level_relation_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_student_assessment_level" UNIQUE (student_id, ai_assessment_id),
  CONSTRAINT "student_level_relation_level_id_fkey" FOREIGN KEY (level_id) REFERENCES "__SCHEMA__".levels (id),
  CONSTRAINT "student_level_relation_student_id_fkey" FOREIGN KEY (student_id) REFERENCES "__SCHEMA__".users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS student_id_ai_assessment_id_bootcamp_id_1763801615880_index ON "__SCHEMA__".student_level_relation USING btree (student_id, ai_assessment_id, bootcamp_id);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."question_evaluation" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."question_evaluation_id_seq"'::regclass) NOT NULL,
  "ai_assessment_id" integer NOT NULL,
  "question" text NOT NULL,
  "topic" character varying(255),
  "difficulty" character varying(50),
  "options" jsonb NOT NULL,
  "selected_answer_by_student" integer,
  "language" character varying(50),
  "status" character varying(50) DEFAULT NULL::character varying,
  "explanation" text,
  "summary" text,
  "recommendations" text,
  "student_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "question_id" integer,
  CONSTRAINT "question_evaluation_pkey" PRIMARY KEY (id),
  CONSTRAINT "question_evaluation_student_id_fkey" FOREIGN KEY (student_id) REFERENCES "__SCHEMA__".users (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."question_student_answer_relation" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."question_student_answer_relation_id_seq"'::regclass) NOT NULL,
  "student_id" integer NOT NULL,
  "question_id" integer NOT NULL,
  "answer" integer,
  "answered_at" timestamp with time zone DEFAULT now(),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "question_student_answer_relation_pkey" PRIMARY KEY (id),
  CONSTRAINT "uniq_student_question_answer" UNIQUE (student_id, question_id),
  CONSTRAINT "question_student_answer_relation_question_id_fkey" FOREIGN KEY (question_id) REFERENCES "__SCHEMA__".questions_by_llm (id),
  CONSTRAINT "question_student_answer_relation_student_id_fkey" FOREIGN KEY (student_id) REFERENCES "__SCHEMA__".users (id)
);
CREATE TABLE IF NOT EXISTS "__SCHEMA__"."llm_usage" (
  "id" integer DEFAULT nextval('"__SCHEMA__"."llm_usage_id_seq"'::regclass) NOT NULL,
  "ai_assessment_id" integer NOT NULL,
  "provider" character varying(50) NOT NULL,
  "prompt" text NOT NULL,
  "response_text" text NOT NULL,
  "latency_ms" integer NOT NULL,
  "usage" jsonb,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  CONSTRAINT "llm_usage_pkey" PRIMARY KEY (id),
  CONSTRAINT "llm_usage_ai_assessment_id_fkey" FOREIGN KEY (ai_assessment_id) REFERENCES "__SCHEMA__".ai_assessment (id) ON DELETE CASCADE
);

ALTER SEQUENCE "__SCHEMA__"."ai_assessment_id_seq" OWNED BY "__SCHEMA__"."ai_assessment"."id";
ALTER SEQUENCE "__SCHEMA__"."ai_assessment_question_sets_id_seq" OWNED BY "__SCHEMA__"."ai_assessment_question_sets"."id";
ALTER SEQUENCE "__SCHEMA__"."ai_assessment_questions_id_seq" OWNED BY "__SCHEMA__"."ai_assessment_questions"."id";
ALTER SEQUENCE "__SCHEMA__"."correct_answers_id_seq" OWNED BY "__SCHEMA__"."correct_answers"."id";
ALTER SEQUENCE "__SCHEMA__"."levels_id_seq" OWNED BY "__SCHEMA__"."levels"."id";
ALTER SEQUENCE "__SCHEMA__"."llm_usage_id_seq" OWNED BY "__SCHEMA__"."llm_usage"."id";
ALTER SEQUENCE "__SCHEMA__"."mcq_question_options_id_seq" OWNED BY "__SCHEMA__"."mcq_question_options"."id";
ALTER SEQUENCE "__SCHEMA__"."question_evaluation_id_seq" OWNED BY "__SCHEMA__"."question_evaluation"."id";
ALTER SEQUENCE "__SCHEMA__"."question_index_outbox_id_seq" OWNED BY "__SCHEMA__"."question_index_outbox"."id";
ALTER SEQUENCE "__SCHEMA__"."question_level_relation_id_seq" OWNED BY "__SCHEMA__"."question_level_relation"."id";
ALTER SEQUENCE "__SCHEMA__"."question_student_answer_relation_id_seq" OWNED BY "__SCHEMA__"."question_student_answer_relation"."id";
ALTER SEQUENCE "__SCHEMA__"."questions_by_llm_id_seq" OWNED BY "__SCHEMA__"."questions_by_llm"."id";
ALTER SEQUENCE "__SCHEMA__"."student_answers_id_seq" OWNED BY "__SCHEMA__"."student_answers"."id";
ALTER SEQUENCE "__SCHEMA__"."student_assessment_id_seq" OWNED BY "__SCHEMA__"."student_assessment"."id";
ALTER SEQUENCE "__SCHEMA__"."student_level_relation_id_seq" OWNED BY "__SCHEMA__"."student_level_relation"."id";
ALTER SEQUENCE "__SCHEMA__"."topic_id_seq" OWNED BY "__SCHEMA__"."topic"."id";
ALTER SEQUENCE "__SCHEMA__"."zuvy_question_explanations_id_seq" OWNED BY "__SCHEMA__"."zuvy_question_explanations"."id";
ALTER SEQUENCE "__SCHEMA__"."zuvy_questions_id_seq" OWNED BY "__SCHEMA__"."zuvy_questions"."id";

-- Lookup seed for levels. Does not copy assessment/question/student data.
INSERT INTO "__SCHEMA__"."levels" (grade, score_range, score_min, score_max, hardship, meaning)
VALUES
  ('A+', '>= 90', 90, NULL, '+20%', 'Expert / Ready for next level'),
  ('A', '80-89', 80, 89, '+10%', 'Strong conceptual understanding'),
  ('B', '70-79', 70, 79, '+5%', 'Competent but needs revision'),
  ('C', '60-69', 60, 69, '0%', 'Basic grasp, needs reinforcement'),
  ('D', '>= 40', 40, 59, '-5%', 'Weak areas identified'),
  ('E', '< 40', NULL, 39, '-10%', 'Requires intervention')
ON CONFLICT (grade) DO NOTHING;
