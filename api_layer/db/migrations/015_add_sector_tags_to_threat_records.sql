-- Migration 015: Add sector_tags to threat_records
ALTER TABLE threat_records ADD COLUMN IF NOT EXISTS sector_tags TEXT[] NOT NULL DEFAULT '{}';
