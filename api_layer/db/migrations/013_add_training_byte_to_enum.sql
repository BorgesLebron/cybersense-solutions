-- Migration 013: Add training_byte to pipeline_content_type enum
-- Required for Kirby's production tasks in scheduler.js

ALTER TYPE pipeline_content_type ADD VALUE IF NOT EXISTS 'training_byte';
