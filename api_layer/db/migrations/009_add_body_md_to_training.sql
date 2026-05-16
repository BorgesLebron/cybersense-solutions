-- Migration 009 — Add body_md to training_modules
-- Required for Kirby to store Training Byte content directly in the database

BEGIN;

ALTER TABLE training_modules ADD COLUMN IF NOT EXISTS body_md TEXT;

COMMIT;
