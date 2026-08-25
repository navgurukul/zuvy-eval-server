ALTER TABLE main.zuvy_questions
  ADD COLUMN IF NOT EXISTS subtopics JSONB;