-- ============================================================
-- QBank: Add "bank" column (3 question banks)
-- Run in Supabase SQL Editor
-- ============================================================

-- Add bank column (default existing questions to 肾内科)
ALTER TABLE qbank_questions
  ADD COLUMN IF NOT EXISTS bank TEXT NOT NULL DEFAULT '肾内科';

-- Update constraint to validate bank values
ALTER TABLE qbank_questions
  ADD CONSTRAINT qbank_questions_bank_check
  CHECK (bank IN ('大内科', '肾内科', '考研'));

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_qbank_questions_bank ON qbank_questions(bank);
