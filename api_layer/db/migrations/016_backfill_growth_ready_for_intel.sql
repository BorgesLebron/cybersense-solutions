-- Migration 016: Backfill ready_for_intel for existing growth records
--
-- Root cause: barbara_runtime.js gated ready_for_intel on isHighPriority
-- (item.priority === 'high'), but Ivan/Charlie assigns priority:'normal' to
-- all growth items. Every growth record entered intel_repository with
-- ready_for_intel:false and was invisible to James' candidate query.
--
-- All records already in intel_repository passed Barbara's quality_flag gate
-- (flagged items return early before repository/process is called), so flipping
-- ready_for_intel = true for all existing growth records is safe.
--
-- Fixed in barbara_runtime.js [ALAN-073] — this migration covers the backlog.

UPDATE intel_repository
SET ready_for_intel = true
WHERE source_type = 'growth'
  AND ready_for_intel = false;
