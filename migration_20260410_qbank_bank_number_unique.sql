-- ============================================================
-- Fix: make question_number unique per bank, not globally
-- Run in Supabase SQL Editor
-- ============================================================

-- Drop the old global unique constraint
ALTER TABLE qbank_questions DROP CONSTRAINT IF EXISTS qbank_questions_question_number_key;
DROP INDEX IF EXISTS idx_qbank_questions_number;

-- Add composite unique constraint (bank + question_number)
ALTER TABLE qbank_questions ADD CONSTRAINT qbank_questions_bank_number_unique UNIQUE (bank, question_number);
