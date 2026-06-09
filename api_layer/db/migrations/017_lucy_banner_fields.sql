-- Migration 017: Lucy banner fields on articles
--
-- Adds banner generation tracking to support Lucy's visual pipeline.
-- Lucy runs in parallel with Jeff/Maya after Rob completes (eic_review).
-- banner_status is a separate track from pipeline_status — editorial chain
-- continues unblocked. Release gate checks banner_status independently.
--
-- Additional fields beyond Gwen's minimum spec:
--   banner_generated_at  — Lucy completion timestamp for admin console display and SLA tracking
--   banner_retry_count   — supports the Retry Banner admin control; enables escalation on repeat failure
--
-- Backfill: articles already approved or published predate Lucy's pipeline.
-- They are marked skipped so Lucy does not queue retroactive generation.
-- Articles currently in draft → eic_review remain pending — Lucy will be
-- dispatched when Rob completes after her runtime is deployed.

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'banner_status') THEN
        CREATE TYPE banner_status AS ENUM ('pending', 'generating', 'ready', 'failed', 'skipped');
    END IF;
END $$;

ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS banner_status         banner_status  NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS banner_url            TEXT,
    ADD COLUMN IF NOT EXISTS share_page_url        TEXT,
    ADD COLUMN IF NOT EXISTS banner_generated_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS banner_retry_count    INTEGER        NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS banner_skipped_by     VARCHAR(100),
    ADD COLUMN IF NOT EXISTS banner_skipped_reason TEXT,
    ADD COLUMN IF NOT EXISTS banner_skipped_at     TIMESTAMPTZ;

-- Backfill approved and published articles as skipped.
-- qa and maya articles remain pending — they haven't been released yet and
-- can receive a banner before publication via admin Generate Banner trigger.
UPDATE articles
SET    banner_status         = 'skipped',
       banner_skipped_by     = 'system',
       banner_skipped_reason = 'Pre-banner pipeline — article predates Lucy visual workflow',
       banner_skipped_at     = now()
WHERE  pipeline_status IN ('approved', 'published');
