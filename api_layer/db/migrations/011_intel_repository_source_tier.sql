-- Migration 011: Add source_tier to intel_repository
-- source_tier: 1 = Tier 1 (primary/authoritative), 2 = Tier 2 (secondary/contextual), NULL = unclassified
-- Set by Barbara during normalization based on ingestion source tags.

ALTER TABLE intel_repository
  ADD COLUMN IF NOT EXISTS source_tier SMALLINT;
