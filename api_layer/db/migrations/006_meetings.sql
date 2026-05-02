-- 006_meetings.sql — Meeting Room and Action Items tables for DASH-003

CREATE TABLE IF NOT EXISTS meetings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  type         VARCHAR(20) NOT NULL CHECK (type IN ('operational','security','editorial','training')),
  convener     VARCHAR(50) NOT NULL,
  initiated_by TEXT NOT NULL,
  agenda       TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS meeting_action_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  owner_agent VARCHAR(50),
  status      VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
CREATE INDEX IF NOT EXISTS idx_meetings_type ON meetings(type);
CREATE INDEX IF NOT EXISTS idx_meeting_action_items_meeting ON meeting_action_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_action_items_status ON meeting_action_items(status);
