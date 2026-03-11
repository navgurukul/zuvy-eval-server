-- Outbox table for question indexing into Qdrant.
-- Run this if you manage schema via raw SQL instead of Drizzle migrations.
-- If the table already exists, add the requested_by_user_id column:
--   ALTER TABLE main.question_index_outbox ADD COLUMN IF NOT EXISTS requested_by_user_id VARCHAR(255);

CREATE TABLE IF NOT EXISTS main.question_index_outbox (
  id SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL,
  requested_by_user_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

