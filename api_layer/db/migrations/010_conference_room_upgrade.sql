-- Migration 010 — Conference Room Upgrade (Structured Meetings)
-- Adding roles and departmental briefing support

BEGIN;

-- Update meetings table with roles and structured briefings
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS lead VARCHAR(50);
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS decision_maker VARCHAR(50);
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS records_agent VARCHAR(50);
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS briefings JSONB DEFAULT '{}'::jsonb;

-- Update action items with department and priority
ALTER TABLE meeting_action_items ADD COLUMN IF NOT EXISTS department VARCHAR(50);
ALTER TABLE meeting_action_items ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';

-- Add index for briefings search
CREATE INDEX IF NOT EXISTS idx_meetings_briefings ON meetings USING GIN (briefings);

COMMIT;
