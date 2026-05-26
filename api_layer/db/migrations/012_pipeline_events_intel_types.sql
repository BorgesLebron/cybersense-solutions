-- Migration 012: Extend pipeline_content_type enum for Barbara's normalization log
--
-- Root cause: pipeline_events.content_type is a PostgreSQL enum that only included
-- article/briefing/training/system. Barbara writes 'intel_repository' as content_type
-- when logging normalization completions — this caused every logPipelineEvent call
-- to fail with "invalid input value for enum pipeline_content_type: intel_repository",
-- silently caught, leaving the ops log panel empty despite Barbara functioning correctly.
--
-- ALTER TYPE ... ADD VALUE is additive-only and does not require a table rewrite.

ALTER TYPE pipeline_content_type ADD VALUE IF NOT EXISTS 'intel_repository';
ALTER TYPE pipeline_content_type ADD VALUE IF NOT EXISTS 'threat_record';
ALTER TYPE pipeline_content_type ADD VALUE IF NOT EXISTS 'intel_item';
