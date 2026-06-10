-- Migration 018 — Add Mario's HTML production statuses to module_status enum
-- and body_html column to training_modules.
--
-- Root cause: Mario polls for modules at 'ready_for_html', writes 'html_ready'
-- or 'html_failed', but these values were never added to the enum. The missing
-- values cause a POLL_ERROR on every Mario tick (every 60s in production).
--
-- Kirby advances modules to 'ready_for_html' when its training byte is approved.
-- Mario converts body_md → body_html and advances to 'html_ready'.

-- ADD VALUE cannot run inside a transaction block in PostgreSQL.
ALTER TYPE module_status ADD VALUE IF NOT EXISTS 'ready_for_html';
ALTER TYPE module_status ADD VALUE IF NOT EXISTS 'html_ready';
ALTER TYPE module_status ADD VALUE IF NOT EXISTS 'html_failed';

-- Mario writes rendered HTML here; column was missing from initial schema.
ALTER TABLE training_modules ADD COLUMN IF NOT EXISTS body_html TEXT;
