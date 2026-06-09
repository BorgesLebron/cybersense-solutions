-- Migration 017: Lucy banner fields on articles
--
-- Adds banner generation tracking to support Lucy's visual pipeline.
-- Lucy runs in parallel with Jeff/Maya after Rob completes (eic_review).
-- banner_status is a separate track from pipeline_status — editorial chain
-- continues unblocked. Release gate checks banner_status independently.
--
-- Column notes:
--   banner_image_url     — public GitHub Pages URL of the committed banner PNG
--   share_page_url       — explicit field for the static OG share page URL;
--                          kept explicit (not derived from slug) to keep the
--                          Alan/Lucy contract clear and avoid silently coupling
--                          URL derivation to slug behavior
--   banner_alt_text      — accessibility and og:image alt for article.html rendering
--   banner_error         — last error message when banner_status = failed; aids debugging
--   banner_generated_at  — Lucy completion timestamp for admin console and SLA tracking
--   banner_attempts      — increments on each Generate/Retry; enables escalation on repeat failure
--   banner_skipped_*     — full audit trail: who, why, when (GM-authorized skips only)
--
-- Provider, model, prompt, and task timing remain in agent_tasks.
--
-- Backfill: articles already approved or published predate Lucy's pipeline.
-- They are marked skipped so Lucy does not queue retroactive generation.
-- Articles currently in draft → eic_review remain pending — Lucy will be
-- dispatched when Rob completes after her runtime is deployed.
-- Articles in qa/maya remain pending — eligible for Generate Banner before release.

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'banner_status') THEN
        CREATE TYPE banner_status AS ENUM ('pending', 'generating', 'ready', 'failed', 'skipped');
    END IF;
END $$;

ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS banner_status         banner_status  NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS banner_image_url       TEXT,
    ADD COLUMN IF NOT EXISTS share_page_url         TEXT,
    ADD COLUMN IF NOT EXISTS banner_alt_text        TEXT,
    ADD COLUMN IF NOT EXISTS banner_error           TEXT,
    ADD COLUMN IF NOT EXISTS banner_generated_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS banner_attempts        INTEGER        NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS banner_skipped_by      VARCHAR(100),
    ADD COLUMN IF NOT EXISTS banner_skipped_reason  TEXT,
    ADD COLUMN IF NOT EXISTS banner_skipped_at      TIMESTAMPTZ;

-- Backfill approved and published articles as skipped.
UPDATE articles
SET    banner_status         = 'skipped',
       banner_skipped_by     = 'system',
       banner_skipped_reason = 'Pre-banner pipeline — article predates Lucy visual workflow',
       banner_skipped_at     = now()
WHERE  pipeline_status IN ('approved', 'published');
