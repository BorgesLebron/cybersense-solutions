-- CyberSense.Solutions — Initial Database Schema
-- Migration 001 — Full platform schema
-- Run: psql $DATABASE_URL -f 001_initial_schema.sql

BEGIN;

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── Slugify function ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION slugify(val TEXT)
RETURNS TEXT AS $$
  SELECT lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(val, '[^a-zA-Z0-9\s-]', '', 'g'),
        '\s+', '-', 'g'
      ),
      '-{2,}', '-', 'g'
    )
  );
$$ LANGUAGE SQL IMMUTABLE;

-- ── Idempotent Type Creation ──────────────────────────────────────────────────
-- We group all ENUMs here so they exist before tables try to use them.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_tier') THEN
        CREATE TYPE user_tier AS ENUM ('free', 'freemium', 'monthly', 'enterprise');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_role_type') THEN
        CREATE TYPE admin_role_type AS ENUM ('gm', 'editor', 'analyst', 'sales', 'training');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'threat_severity') THEN
        CREATE TYPE threat_severity AS ENUM ('critical', 'high', 'medium', 'low');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'threat_priority') THEN
        CREATE TYPE threat_priority AS ENUM ('immediate', 'high', 'normal', 'watch');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'intel_item_type') THEN
        CREATE TYPE intel_item_type AS ENUM ('innovation', 'growth', 'policy');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'intel_priority') THEN
        CREATE TYPE intel_priority AS ENUM ('high', 'normal', 'watch');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'source_type') THEN
        CREATE TYPE source_type AS ENUM ('threat', 'innovation', 'growth', 'policy');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'article_section') THEN
        CREATE TYPE article_section AS ENUM ('threat', 'policy', 'innovation', 'growth', 'training');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'content_tier') THEN
        CREATE TYPE content_tier AS ENUM ('freemium', 'monthly', 'enterprise');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'article_status') THEN
        CREATE TYPE article_status AS ENUM ('draft', 'dev_edit', 'eic_review', 'qa', 'maya', 'approved', 'published');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'briefing_status') THEN
        CREATE TYPE briefing_status AS ENUM ('draft', 'dev_edit', 'eic_review', 'qa', 'maya', 'approved', 'published');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pipeline_content_type') THEN
        CREATE TYPE pipeline_content_type AS ENUM ('article', 'briefing', 'training', 'system');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'social_platform') THEN
        CREATE TYPE social_platform AS ENUM ('linkedin', 'meta', 'x', 'tiktok', 'youtube');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'social_phase') THEN
        CREATE TYPE social_phase AS ENUM ('0700_main', '0900_byte', '1200_note');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'module_type') THEN
        CREATE TYPE module_type AS ENUM ('video', 'lab', 'step_by_step', 'glossary', 'training_byte');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'module_phase') THEN
        CREATE TYPE module_phase AS ENUM ('1_video', '2_lab', '3_simulation', 'library');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'module_status') THEN
        CREATE TYPE module_status AS ENUM ('draft', 'qa', 'maya', 'published');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'completion_status') THEN
        CREATE TYPE completion_status AS ENUM ('not_started', 'in_progress', 'completed');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'simulation_type') THEN
        CREATE TYPE simulation_type AS ENUM ('phishing', 'spear_phishing', 'vishing', 'smishing');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'simulation_outcome') THEN
        CREATE TYPE simulation_outcome AS ENUM ('reported', 'clicked', 'ignored');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_tier') THEN
        CREATE TYPE subscription_tier   AS ENUM ('monthly', 'enterprise');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
        CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'cancelled', 'paused');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_status') THEN
        CREATE TYPE lead_status AS ENUM ('new', 'qualified', 'proposal', 'negotiating', 'won', 'lost');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_source') THEN
        CREATE TYPE lead_source AS ENUM ('linkedin', 'meta', 'x', 'youtube', 'direct', 'referral', 'partner');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'partner_type') THEN
        CREATE TYPE partner_type   AS ENUM ('affiliate', 'sponsor', 'co_marketing', 'reseller');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'partner_status') THEN
        CREATE TYPE partner_status AS ENUM ('prospect', 'discovery', 'proposal', 'active', 'paused');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_status') THEN
        CREATE TYPE task_status AS ENUM ('queued', 'in_progress', 'complete', 'failed', 'escalated');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'risk_domain') THEN
        CREATE TYPE risk_domain AS ENUM ('operational', 'intelligence', 'reputational', 'financial', 'compliance');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'risk_severity') THEN
        CREATE TYPE risk_severity AS ENUM ('high', 'medium', 'low');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'risk_status') THEN
        CREATE TYPE risk_status   AS ENUM ('open', 'mitigating', 'resolved');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'escalation_severity') THEN
        CREATE TYPE escalation_severity AS ENUM ('critical', 'high', 'medium', 'low');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'escalation_status') THEN
        CREATE TYPE escalation_status AS ENUM ('open', 'acknowledged', 'resolved');
    END IF;

END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- DOMAIN 1: USERS & AUTH
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS organizations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  VARCHAR(255)  NOT NULL,
  domain                VARCHAR(255),                          -- email domain for SSO matching
  seat_count            INTEGER       NOT NULL DEFAULT 0,
  seat_used             INTEGER       NOT NULL DEFAULT 0,
  stripe_subscription_id VARCHAR(255),
  billing_contact_id    UUID,                                  -- FK set after users table created
  account_manager_id    VARCHAR(100),                          -- agent name (Joe)
  health_score          INTEGER       NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  renewal_date          DATE,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT organizations_seat_used_check CHECK (seat_used <= seat_count)
);

CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 VARCHAR(320)  NOT NULL,
  password_hash         VARCHAR(255)  NOT NULL,
  full_name             VARCHAR(255)  NOT NULL,
  tier                  user_tier     NOT NULL DEFAULT 'free',
  org_id                UUID          REFERENCES organizations(id) ON DELETE SET NULL,
  department            VARCHAR(255),                          -- for enterprise training grouping
  is_org_admin          BOOLEAN       NOT NULL DEFAULT false,
  stripe_customer_id    VARCHAR(255),
  email_verified        BOOLEAN       NOT NULL DEFAULT false,
  email_subscribed      BOOLEAN       NOT NULL DEFAULT true,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,                          -- soft delete
  CONSTRAINT users_email_unique UNIQUE (email)
);

-- Now add FK from organizations back to users
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_org_billing_contact') THEN
        ALTER TABLE organizations ADD CONSTRAINT fk_org_billing_contact 
        FOREIGN KEY (billing_contact_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS admin_roles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  admin_role_type NOT NULL,
  dashboard_sections    JSONB         NOT NULL DEFAULT '[]',  -- array of permitted panel IDs
  granted_by            UUID          REFERENCES users(id),
  granted_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT admin_roles_user_unique UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash            VARCHAR(64)   NOT NULL,               -- SHA-256 of refresh/verify token
  ip_address            INET,
  user_agent            TEXT,
  expires_at            TIMESTAMPTZ   NOT NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name            VARCHAR(100)  NOT NULL,
  team                  VARCHAR(100)  NOT NULL,
  token_hash            VARCHAR(64)   NOT NULL,               -- SHA-256 of JWT
  active                BOOLEAN       NOT NULL DEFAULT true,
  rotated_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT agent_tokens_name_unique UNIQUE (agent_name)
);

-- ══════════════════════════════════════════════════════════════════════════════
-- DOMAIN 2: INTELLIGENCE
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS threat_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cve_id                VARCHAR(30)   NOT NULL,
  threat_name           VARCHAR(500)  NOT NULL,
  severity              threat_severity NOT NULL,
  cvss_score            DECIMAL(3,1)  NOT NULL CHECK (cvss_score BETWEEN 0.0 AND 10.0),
  category              VARCHAR(100)  NOT NULL,               -- RCE, SQLi, privilege-esc, etc.
  source_url            TEXT,                                 -- internal only, never exposed via API
  raw_data              JSONB         NOT NULL DEFAULT '{}',  -- Rick's full structured output
  tags                  TEXT[]        NOT NULL DEFAULT '{}',
  priority              threat_priority NOT NULL DEFAULT 'normal',
  ingested_by           VARCHAR(100)  NOT NULL DEFAULT 'Rick',
  ingested_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  article_id            UUID,                                 -- FK added after articles table
  CONSTRAINT threat_records_cve_unique UNIQUE (cve_id)
);

CREATE TABLE IF NOT EXISTS intel_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                  intel_item_type NOT NULL,
  category              VARCHAR(100)  NOT NULL,               -- AI, quantum, cloud, NIST, new technology, etc.
  headline              TEXT          NOT NULL,
  summary               TEXT          NOT NULL,
  tags                  TEXT[]        NOT NULL DEFAULT '{}',
  priority              intel_priority NOT NULL DEFAULT 'normal',
  ingested_by           VARCHAR(100)  NOT NULL,               -- Ivan/Charlie
  ingested_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  used_in_briefing      BOOLEAN       NOT NULL DEFAULT false,
  article_id            UUID                                  -- FK added after articles table
);

CREATE TABLE IF NOT EXISTS intel_repository (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type           source_type   NOT NULL,
  source_id             UUID          NOT NULL,               -- polymorphic: threat_records or intel_items
  normalized_data       JSONB         NOT NULL DEFAULT '{}',  -- Barbara's structured output
  correlation_tags      TEXT[]        NOT NULL DEFAULT '{}',  -- cross-item relationship tags
  ready_for_intel       BOOLEAN       NOT NULL DEFAULT true,
  ready_for_awareness   BOOLEAN       NOT NULL DEFAULT true,
  processed_by          VARCHAR(100)  NOT NULL DEFAULT 'Barbara',
  processed_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT intel_repository_source_unique UNIQUE (source_id)
);

CREATE TABLE IF NOT EXISTS policy_updates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  framework             VARCHAR(100)  NOT NULL,               -- NIST, ISO, PCI-DSS, HIPAA, etc.
  version               VARCHAR(50),
  change_summary        TEXT          NOT NULL,
  effective_date        DATE,
  article_id            UUID,                                 -- FK added after articles table
  ingested_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════════════════════
-- DOMAIN 3: CONTENT
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS articles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 VARCHAR(500)  NOT NULL,
  slug                  VARCHAR(500)  NOT NULL,
  section               article_section NOT NULL,
  body_md               TEXT          NOT NULL,
  body_html             TEXT,                                 -- rendered on publish
  access_tier           content_tier  NOT NULL DEFAULT 'monthly',
  pipeline_status       article_status NOT NULL DEFAULT 'draft',
  qa_passed_at          TIMESTAMPTZ,
  maya_approved_at      TIMESTAMPTZ,
  published_at          TIMESTAMPTZ,
  view_count            INTEGER       NOT NULL DEFAULT 0,
  read_time_min         INTEGER       NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT articles_slug_unique UNIQUE (slug)
);

-- Now add article FKs to intelligence tables
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_threat_article') THEN
        ALTER TABLE threat_records ADD CONSTRAINT fk_threat_article 
        FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_intel_item_article') THEN
        ALTER TABLE intel_items ADD CONSTRAINT fk_intel_item_article 
        FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_policy_article') THEN
        ALTER TABLE policy_updates ADD CONSTRAINT fk_policy_article 
        FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS briefings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_date          DATE          NOT NULL,
  subject_line          VARCHAR(500)  NOT NULL,
  body_md               TEXT          NOT NULL,
  body_html             TEXT,
  threat_item_ids       UUID[]        NOT NULL DEFAULT '{}',  -- must have exactly 3
  innovation_item_ids   UUID[]        NOT NULL DEFAULT '{}',  -- must have exactly 2
  growth_item_id        UUID,
  training_byte_id      UUID,
  pipeline_status       briefing_status NOT NULL DEFAULT 'draft',
  draft_completed_at    TIMESTAMPTZ,                          -- Ruth's 0615 CT deadline marker
  qa_passed_at          TIMESTAMPTZ,
  maya_approved_at      TIMESTAMPTZ,
  published_at          TIMESTAMPTZ,
  open_count            INTEGER       NOT NULL DEFAULT 0,
  click_count           INTEGER       NOT NULL DEFAULT 0,
  CONSTRAINT briefings_edition_date_unique UNIQUE (edition_date),
  CONSTRAINT briefings_threat_count CHECK (array_length(threat_item_ids, 1) = 3),
  CONSTRAINT briefings_innovation_count CHECK (array_length(innovation_item_ids, 1) = 2)
);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type          pipeline_content_type NOT NULL,
  content_id            UUID          NOT NULL,
  from_status           VARCHAR(50),
  to_status             VARCHAR(50)   NOT NULL,
  agent_name            VARCHAR(100)  NOT NULL,
  notes                 TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS social_posts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  briefing_id           UUID          NOT NULL REFERENCES briefings(id),
  platform              social_platform NOT NULL,
  agent_name            VARCHAR(100)  NOT NULL,
  post_body             TEXT          NOT NULL,
  phase                 social_phase  NOT NULL,
  scheduled_at          TIMESTAMPTZ,
  published_at          TIMESTAMPTZ,
  reach                 INTEGER       NOT NULL DEFAULT 0,
  engagements           INTEGER       NOT NULL DEFAULT 0,
  conversions           INTEGER       NOT NULL DEFAULT 0      -- sign-ups attributed
);

-- ══════════════════════════════════════════════════════════════════════════════
-- DOMAIN 4: TRAINING & ZERO-TRUST
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS training_modules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 VARCHAR(500)  NOT NULL,
  type                  module_type   NOT NULL,
  phase                 module_phase  NOT NULL,
  zt_module             VARCHAR(100),                         -- email_security|phishing|malware|etc.
  access_tier           content_tier  NOT NULL DEFAULT 'monthly',
  duration_min          INTEGER,
  content_url           TEXT,                                 -- S3 or CDN URL
  pipeline_status       module_status NOT NULL DEFAULT 'draft',
  qa_passed_at          TIMESTAMPTZ,
  maya_approved_at      TIMESTAMPTZ,
  published_at          TIMESTAMPTZ,
  created_by            VARCHAR(100)  NOT NULL,               -- Kirby or Matt
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Add FK from briefings to training_modules
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_briefing_training_byte') THEN
        ALTER TABLE briefings ADD CONSTRAINT fk_briefing_training_byte 
        FOREIGN KEY (training_byte_id) REFERENCES training_modules(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS training_completions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID          NOT NULL REFERENCES users(id),
  module_id             UUID          NOT NULL REFERENCES training_modules(id),
  org_id                UUID          REFERENCES organizations(id),
  department            VARCHAR(255),
  status                completion_status NOT NULL DEFAULT 'not_started',
  score                 INTEGER       CHECK (score BETWEEN 0 AND 100),
  time_spent_min        INTEGER,
  completed_at          TIMESTAMPTZ,
  assigned_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT training_completions_user_module_unique UNIQUE (user_id, module_id)
);

CREATE TABLE IF NOT EXISTS simulations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID          NOT NULL REFERENCES organizations(id),
  type                  simulation_type NOT NULL,
  campaign_name         VARCHAR(255)  NOT NULL,
  target_count          INTEGER       NOT NULL CHECK (target_count > 0),
  reported_count        INTEGER       NOT NULL DEFAULT 0,
  clicked_count         INTEGER       NOT NULL DEFAULT 0,
  launched_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  closed_at             TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS simulation_results (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  simulation_id         UUID          NOT NULL REFERENCES simulations(id),
  user_id               UUID          NOT NULL REFERENCES users(id),
  outcome               simulation_outcome NOT NULL,
  response_time_sec     INTEGER,
  department            VARCHAR(255),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════════════════════
-- DOMAIN 5: REVENUE & SALES
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subscriptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID          REFERENCES users(id),
  org_id                   UUID          REFERENCES organizations(id),
  stripe_subscription_id   VARCHAR(255)  NOT NULL,
  tier                     subscription_tier NOT NULL,
  status                   subscription_status NOT NULL DEFAULT 'active',
  mrr_cents                INTEGER       NOT NULL DEFAULT 0 CHECK (mrr_cents >= 0),
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  cancel_reason            TEXT,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_stripe_id_unique UNIQUE (stripe_subscription_id),
  CONSTRAINT subscriptions_owner_check CHECK (user_id IS NOT NULL OR org_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id       VARCHAR(255)  NOT NULL,
  event_type            VARCHAR(255)  NOT NULL,
  subscription_id       UUID          REFERENCES subscriptions(id),
  amount_cents          INTEGER,
  payload               JSONB         NOT NULL DEFAULT '{}',
  processed_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT stripe_events_event_id_unique UNIQUE (stripe_event_id)
);

CREATE TABLE IF NOT EXISTS leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 VARCHAR(320)  NOT NULL,
  full_name             VARCHAR(255)  NOT NULL,
  company               VARCHAR(255),
  source                lead_source   NOT NULL DEFAULT 'direct',
  status                lead_status   NOT NULL DEFAULT 'new',
  assigned_to           VARCHAR(100)  NOT NULL DEFAULT 'Mary',
  target_tier           subscription_tier,
  est_seats             INTEGER,
  est_value_cents       INTEGER,
  notes                 TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  converted_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS partners (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  VARCHAR(255)  NOT NULL,
  type                  partner_type  NOT NULL,
  status                partner_status NOT NULL DEFAULT 'prospect',
  monthly_value_cents   INTEGER,
  commission_pct        DECIMAL(5,2),
  contract_start        DATE,
  contract_end          DATE,
  owner_agent           VARCHAR(100)
);

-- ══════════════════════════════════════════════════════════════════════════════
-- DOMAIN 6: OPERATIONS
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_tasks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name            VARCHAR(100)  NOT NULL,
  task_type             VARCHAR(100)  NOT NULL,
  content_type          pipeline_content_type NOT NULL,
  content_id            UUID          NOT NULL,
  status                task_status   NOT NULL DEFAULT 'queued',
  sla_deadline          TIMESTAMPTZ,
  started_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  latency_sec           INTEGER,
  error_message         TEXT
);

CREATE TABLE IF NOT EXISTS risk_register (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                risk_domain   NOT NULL,
  title                 VARCHAR(500)  NOT NULL,
  description           TEXT,
  severity              risk_severity NOT NULL,
  score                 INTEGER       NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
  status                risk_status   NOT NULL DEFAULT 'open',
  owner_agent           VARCHAR(100),
  raised_by             VARCHAR(100)  NOT NULL,
  due_date              DATE,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS handoff_sla_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent            VARCHAR(100)  NOT NULL,
  to_agent              VARCHAR(100)  NOT NULL,
  content_id            UUID          NOT NULL,
  expected_at           TIMESTAMPTZ   NOT NULL,
  actual_at             TIMESTAMPTZ   NOT NULL,
  delta_sec             INTEGER       NOT NULL,               -- negative = early, positive = late
  breached              BOOLEAN       NOT NULL DEFAULT false,
  escalated_to          VARCHAR(100)                          -- Barret or Henry if breached
);

CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date         DATE          NOT NULL,
  total_subscribers     INTEGER       NOT NULL DEFAULT 0,
  paid_accounts         INTEGER       NOT NULL DEFAULT 0,
  enterprise_accounts   INTEGER       NOT NULL DEFAULT 0,
  mrr_cents             INTEGER       NOT NULL DEFAULT 0,
  churn_rate            DECIMAL(5,2)  NOT NULL DEFAULT 0,
  articles_published    INTEGER       NOT NULL DEFAULT 0,
  briefings_published   INTEGER       NOT NULL DEFAULT 0,
  avg_open_rate         DECIMAL(5,2)  NOT NULL DEFAULT 0,
  open_risk_count       INTEGER       NOT NULL DEFAULT 0,
  agent_tasks_completed INTEGER       NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_snapshots_date_unique UNIQUE (snapshot_date)
);

CREATE TABLE IF NOT EXISTS audit_trail (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor                 VARCHAR(255)  NOT NULL,               -- user_id or agent_name
  action                VARCHAR(255)  NOT NULL,
  target_agent          VARCHAR(100),
  reason                TEXT,
  affected_content_id   UUID,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS escalations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent            VARCHAR(100)  NOT NULL,
  to_agent              VARCHAR(100)  NOT NULL,
  reason                TEXT          NOT NULL,
  content_id            UUID,
  severity              escalation_severity NOT NULL,
  status                escalation_status NOT NULL DEFAULT 'open',
  acknowledged_at       TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════════════════════════

-- Users
CREATE INDEX IF NOT EXISTS idx_users_email         ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_tier          ON users (tier)         WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_org_id        ON users (org_id)       WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_stripe        ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Sessions
CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires    ON sessions (expires_at);

-- Threat records
CREATE INDEX IF NOT EXISTS idx_threat_severity     ON threat_records (severity);
CREATE INDEX IF NOT EXISTS idx_threat_priority     ON threat_records (priority);
CREATE INDEX IF NOT EXISTS idx_threat_ingested_at  ON threat_records (ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_threat_article_id   ON threat_records (article_id) WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_threat_cve_trgm     ON threat_records USING gin (cve_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_threat_name_trgm    ON threat_records USING gin (threat_name gin_trgm_ops);

-- Intel items
CREATE INDEX IF NOT EXISTS idx_intel_type          ON intel_items (type);
CREATE INDEX IF NOT EXISTS idx_intel_priority      ON intel_items (priority);
CREATE INDEX IF NOT EXISTS idx_intel_unused        ON intel_items (used_in_briefing) WHERE used_in_briefing = false;
CREATE INDEX IF NOT EXISTS idx_intel_ingested_at   ON intel_items (ingested_at DESC);

-- Intel repository
CREATE INDEX IF NOT EXISTS idx_repo_ready_intel    ON intel_repository (ready_for_intel)   WHERE ready_for_intel = true;
CREATE INDEX IF NOT EXISTS idx_repo_ready_aware    ON intel_repository (ready_for_awareness) WHERE ready_for_awareness = true;
CREATE INDEX IF NOT EXISTS idx_repo_source_type    ON intel_repository (source_type);

-- Articles
CREATE INDEX IF NOT EXISTS idx_articles_status     ON articles (pipeline_status);
CREATE INDEX IF NOT EXISTS idx_articles_section    ON articles (section, pipeline_status);
CREATE INDEX IF NOT EXISTS idx_articles_published  ON articles (published_at DESC) WHERE pipeline_status = 'published';
CREATE INDEX IF NOT EXISTS idx_articles_tier       ON articles (access_tier);
CREATE INDEX IF NOT EXISTS idx_articles_title_trgm ON articles USING gin (title gin_trgm_ops);

-- Briefings
CREATE INDEX IF NOT EXISTS idx_briefings_date      ON briefings (edition_date DESC);
CREATE INDEX IF NOT EXISTS idx_briefings_status    ON briefings (pipeline_status);

-- Pipeline events
CREATE INDEX IF NOT EXISTS idx_pe_content          ON pipeline_events (content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_pe_created_at       ON pipeline_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_agent            ON pipeline_events (agent_name);
CREATE INDEX IF NOT EXISTS idx_pe_rejections       ON pipeline_events (to_status, created_at) WHERE to_status = 'draft';

-- Social posts
CREATE INDEX IF NOT EXISTS idx_social_briefing     ON social_posts (briefing_id);
CREATE INDEX IF NOT EXISTS idx_social_platform     ON social_posts (platform);
CREATE INDEX IF NOT EXISTS idx_social_published    ON social_posts (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_phase        ON social_posts (phase);

-- Training
CREATE INDEX IF NOT EXISTS idx_tm_status           ON training_modules (pipeline_status);
CREATE INDEX IF NOT EXISTS idx_tm_type             ON training_modules (type);
CREATE INDEX IF NOT EXISTS idx_tm_phase            ON training_modules (phase);
CREATE INDEX IF NOT EXISTS idx_tm_zt               ON training_modules (zt_module) WHERE zt_module IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tc_user             ON training_completions (user_id);
CREATE INDEX IF NOT EXISTS idx_tc_org              ON training_completions (org_id);
CREATE INDEX IF NOT EXISTS idx_tc_org_dept         ON training_completions (org_id, department);
CREATE INDEX IF NOT EXISTS idx_tc_module           ON training_completions (module_id);
CREATE INDEX IF NOT EXISTS idx_sim_org             ON simulations (org_id);
CREATE INDEX IF NOT EXISTS idx_simres_sim          ON simulation_results (simulation_id);
CREATE INDEX IF NOT EXISTS idx_simres_user         ON simulation_results (user_id);

-- Revenue
CREATE INDEX IF NOT EXISTS idx_sub_user            ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_sub_org             ON subscriptions (org_id);
CREATE INDEX IF NOT EXISTS idx_sub_status          ON subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_sub_tier            ON subscriptions (tier);
CREATE INDEX IF NOT EXISTS idx_sub_period_end      ON subscriptions (current_period_end) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_stripe_type         ON stripe_events (event_type);

-- ══════════════════════════════════════════════════════════════════════════════
-- SALES & OPERATIONS (DEFENSIVE INDEXING)
-- ══════════════════════════════════════════════════════════════════════════════

-- Sales
CREATE INDEX IF NOT EXISTS idx_leads_status    ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned  ON leads (assigned_to);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='created_at') THEN
        CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at DESC);
    END IF;
END $$;

-- Operations
CREATE INDEX IF NOT EXISTS idx_tasks_agent     ON agent_tasks (agent_name);
CREATE INDEX IF NOT EXISTS idx_tasks_status    ON agent_tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_content   ON agent_tasks (content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_tasks_sla       ON agent_tasks (sla_deadline) WHERE sla_deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_failed    ON agent_tasks (agent_name, status, started_at) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_risk_status     ON risk_register (status, severity);
CREATE INDEX IF NOT EXISTS idx_risk_domain     ON risk_register (domain);
CREATE INDEX IF NOT EXISTS idx_sla_breached    ON handoff_sla_log (breached) WHERE breached = true;
CREATE INDEX IF NOT EXISTS idx_sla_content     ON handoff_sla_log (content_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_trail (actor);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations (status, severity);
CREATE INDEX IF NOT EXISTS idx_escalations_to   ON escalations (to_agent, status);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agent_tasks' AND column_name='started_at') THEN
        CREATE INDEX IF NOT EXISTS idx_tasks_started ON agent_tasks (started_at DESC);
    END IF;
    
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='audit_trail' AND column_name='created_at') THEN
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_trail (created_at DESC);
    END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- TRIGGERS
-- ══════════════════════════════════════════════════════════════════════════════

-- Auto-increment seat_used when a user is assigned to an org
CREATE OR REPLACE FUNCTION update_org_seat_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.org_id IS NOT NULL THEN
    UPDATE organizations SET seat_used = seat_used + 1 WHERE id = NEW.org_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.org_id IS DISTINCT FROM NEW.org_id THEN
      IF OLD.org_id IS NOT NULL THEN
        UPDATE organizations SET seat_used = GREATEST(0, seat_used - 1) WHERE id = OLD.org_id;
      END IF;
      IF NEW.org_id IS NOT NULL THEN
        UPDATE organizations SET seat_used = seat_used + 1 WHERE id = NEW.org_id;
      END IF;
    END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.org_id IS NOT NULL THEN
    UPDATE organizations SET seat_used = GREATEST(0, seat_used - 1) WHERE id = OLD.org_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_seat_count
  AFTER INSERT OR UPDATE OF org_id OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION update_org_seat_count();

-- Auto-render body_html from body_md on article publish
-- (Actual MD→HTML rendering happens in app layer; this sets published_at timestamp)
CREATE OR REPLACE FUNCTION set_published_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.pipeline_status = 'published' AND OLD.pipeline_status != 'published' THEN
    NEW.published_at = COALESCE(NEW.published_at, now());
  END IF;
  IF NEW.pipeline_status = 'maya' AND OLD.pipeline_status != 'maya' THEN
    NEW.maya_approved_at = COALESCE(NEW.maya_approved_at, now());
  END IF;
  IF NEW.pipeline_status = 'qa' AND OLD.pipeline_status != 'qa' THEN
    NEW.qa_passed_at = COALESCE(NEW.qa_passed_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_article_timestamps
  BEFORE UPDATE OF pipeline_status ON articles
  FOR EACH ROW EXECUTE FUNCTION set_published_at();

CREATE TRIGGER trg_briefing_timestamps
  BEFORE UPDATE OF pipeline_status ON briefings
  FOR EACH ROW EXECUTE FUNCTION set_published_at();

-- Mark intel_items as used when added to a briefing
CREATE OR REPLACE FUNCTION mark_intel_items_used()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.pipeline_status = 'published' AND OLD.pipeline_status != 'published' THEN
    UPDATE intel_items SET used_in_briefing = true
    WHERE id = ANY(NEW.innovation_item_ids)
       OR id = NEW.growth_item_id;
    UPDATE threat_records SET article_id = NULL
    WHERE id = ANY(NEW.threat_item_ids) AND article_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_briefing_mark_items_used
  BEFORE UPDATE OF pipeline_status ON briefings
  FOR EACH ROW EXECUTE FUNCTION mark_intel_items_used();

-- ══════════════════════════════════════════════════════════════════════════════
-- MATERIALIZED VIEW: nightly dashboard snapshot
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Materialized View Safety Wrap ──
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') AND
       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscriptions') THEN
        
        DROP MATERIALIZED VIEW IF EXISTS mv_dashboard_current;
        
        CREATE MATERIALIZED VIEW mv_dashboard_current AS
        SELECT
            CURRENT_DATE AS snapshot_date,
            (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS total_subscribers,
            (SELECT COUNT(*) FROM subscriptions WHERE status = 'active') AS paid_accounts,
            (SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND tier = 'enterprise') AS enterprise_accounts,
            (SELECT COALESCE(SUM(mrr_cents), 0) FROM subscriptions WHERE status = 'active') AS mrr_cents,
            (SELECT ROUND(
                COUNT(*) FILTER (WHERE cancelled_at > now() - interval '30 days')::DECIMAL / 
                NULLIF(COUNT(*) FILTER (WHERE created_at < now() - interval '30 days'), 0) * 100, 2 
            ) FROM subscriptions) AS churn_rate,
            (SELECT COUNT(*) FROM articles WHERE pipeline_status = 'published'
                AND published_at > now() - interval '30 days') AS articles_published,
            (SELECT COUNT(*) FROM briefings WHERE pipeline_status = 'published'
                AND published_at > now() - interval '30 days') AS briefings_published,
            (SELECT ROUND(AVG(
                CASE WHEN open_count > 0 AND click_count > 0
                     THEN open_count::DECIMAL / NULLIF(click_count, 0) ELSE 0 END
            ), 2) FROM briefings WHERE published_at > now() - interval '30 days') AS avg_open_rate,
            (SELECT COUNT(*) FROM risk_register WHERE status = 'open') AS open_risk_count,
            (SELECT COUNT(*) FROM agent_tasks WHERE DATE(started_at) = CURRENT_DATE) AS agent_tasks_completed
        WITH NO DATA;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_dashboard ON mv_dashboard_current (snapshot_date);
    END IF;
END $$;

-- Refresh command (run nightly via pg_cron or app scheduler):
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dashboard_current;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEED DATA: Admin roles, agent token placeholders
-- ══════════════════════════════════════════════════════════════════════════════

-- Placeholder agent token rows (tokens rotated via admin API before use)
INSERT INTO agent_tokens (agent_name, team, token_hash, active) VALUES
  ('Rick',         'acquisition', 'placeholder', true),
  ('Ivan/Charlie', 'acquisition', 'placeholder', true),
  ('Barbara',      'analyst',     'placeholder', true),
  ('Laura',        'analyst',     'placeholder', true),
  ('Jim',          'analyst',     'placeholder', true),
  ('Jeff',         'analyst',     'placeholder', true),
  ('James',        'intel',       'placeholder', true),
  ('Jason',        'intel',       'placeholder', true),
  ('Rob',          'intel',       'placeholder', true),
  ('Ruth',         'awareness',   'placeholder', true),
  ('Peter',        'awareness',   'placeholder', true),
  ('Ed',           'awareness',   'placeholder', true),
  ('Kirby',        'training',    'placeholder', true),
  ('Mario',        'training',    'placeholder', true),
  ('Matt',         'training',    'placeholder', true),
  ('Mary',         'sales',       'placeholder', true),
  ('William',      'sales',       'placeholder', true),
  ('Joe',          'sales',       'placeholder', true),
  ('Oliver',       'social',      'placeholder', true),
  ('Lucy',         'social',      'placeholder', true),
  ('Riley',        'social',      'placeholder', true),
  ('Ethan',        'social',      'placeholder', true),
  ('Henry',        'management',  'placeholder', true),
  ('Valerie',      'management',  'placeholder', true),
  ('Victor',       'management',  'placeholder', true),
  ('Barret',       'management',  'placeholder', true),
  ('Alex',         'management',  'placeholder', true),
  ('Maya',         'management',  'placeholder', true)
ON CONFLICT (agent_name) DO NOTHING;

COMMIT;
