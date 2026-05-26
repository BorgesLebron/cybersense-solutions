-- Migration 014: Add cwe_id to threat_records
ALTER TABLE threat_records ADD COLUMN IF NOT EXISTS cwe_id TEXT;
