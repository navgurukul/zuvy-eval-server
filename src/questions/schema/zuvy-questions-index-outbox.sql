-- Outbox table for question indexing into Qdrant.
-- Run this if you manage schema via raw SQL instead of Drizzle migrations.

CREATE TABLE IF NOT EXISTS main.question_index_outbox (
  id SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

