-- Manual SQL helper (if you don't use Drizzle migrations)
-- Adds org_id to main.zuvy_questions so generated questions can be mapped to an org.
ALTER TABLE main.zuvy_questions
  ADD COLUMN IF NOT EXISTS org_id VARCHAR(255);

