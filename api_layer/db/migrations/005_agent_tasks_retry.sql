-- Migration 005: Add retry tracking to agent_tasks
-- Enables exponential-backoff retry when agent webhook delivery fails.

ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS retry_count  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_after  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tasks_retry
  ON agent_tasks (retry_after)
  WHERE status = 'queued' AND retry_count > 0;
