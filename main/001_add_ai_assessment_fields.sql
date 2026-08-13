ALTER TABLE ai_assessment
  ADD COLUMN IF NOT EXISTS chapter_ids jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pool_topics jsonb DEFAULT '[]'::jsonb;
