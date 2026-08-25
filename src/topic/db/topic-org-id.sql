-- Run before deploying the org-scoped Topic APIs.
-- Existing rows need a valid organization value before enforcing NOT NULL.
ALTER TABLE main.topic
  ADD COLUMN IF NOT EXISTS org_id VARCHAR(255);
