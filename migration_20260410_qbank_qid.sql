-- ============================================================
-- QBank: Replace question_number with auto-generated qid
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Drop old unique constraints on question_number
ALTER TABLE qbank_questions DROP CONSTRAINT IF EXISTS qbank_questions_question_number_key;
ALTER TABLE qbank_questions DROP CONSTRAINT IF EXISTS qbank_questions_bank_number_unique;
DROP INDEX IF EXISTS idx_qbank_questions_number;

-- 2. Make question_number nullable (kept for display only, not unique)
ALTER TABLE qbank_questions ALTER COLUMN question_number DROP NOT NULL;

-- 3. Add qid column: short unique question code (like UWorld)
ALTER TABLE qbank_questions ADD COLUMN IF NOT EXISTS qid TEXT;

-- 4. Generate qid for existing questions that don't have one
UPDATE qbank_questions SET qid = upper(substr(md5(random()::text), 1, 6))
  WHERE qid IS NULL;

-- 5. Make qid unique and not null
ALTER TABLE qbank_questions ALTER COLUMN qid SET NOT NULL;
ALTER TABLE qbank_questions ADD CONSTRAINT qbank_questions_qid_unique UNIQUE (qid);
CREATE INDEX IF NOT EXISTS idx_qbank_questions_qid ON qbank_questions(qid);
