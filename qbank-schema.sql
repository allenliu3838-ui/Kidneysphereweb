-- ============================================================
-- QBank (Question Bank) Schema
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Questions table
CREATE TABLE IF NOT EXISTS qbank_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_number INTEGER NOT NULL UNIQUE,       -- global sequential number (第1题, 第2题…)
  subject       TEXT NOT NULL DEFAULT '未分类',   -- e.g. 心血管, 呼吸/重症, 血液…
  difficulty    SMALLINT NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 3),
  stem          TEXT NOT NULL,                    -- clinical vignette / 题干
  question_text TEXT NOT NULL DEFAULT '',         -- the actual question sentence
  choices       JSONB NOT NULL DEFAULT '[]',      -- [{label:"A", text:"…", correct:false}, …]
  explanation   TEXT NOT NULL DEFAULT '',         -- overall explanation
  choice_explanations JSONB NOT NULL DEFAULT '[]', -- [{label:"A", text:"…"}, …]
  "references"  TEXT NOT NULL DEFAULT '',         -- 参考文献
  status        TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','retired')),
  author_id     UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qbank_questions_subject ON qbank_questions(subject);
CREATE INDEX IF NOT EXISTS idx_qbank_questions_status  ON qbank_questions(status);
CREATE INDEX IF NOT EXISTS idx_qbank_questions_number  ON qbank_questions(question_number);

-- 2. User answers table
CREATE TABLE IF NOT EXISTS qbank_user_answers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id),
  question_id   UUID NOT NULL REFERENCES qbank_questions(id),
  chosen_label  TEXT NOT NULL,                    -- "A", "B", etc.
  is_correct    BOOLEAN NOT NULL,
  time_spent_seconds INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qbank_answers_user     ON qbank_user_answers(user_id);
CREATE INDEX IF NOT EXISTS idx_qbank_answers_question ON qbank_user_answers(question_id);
CREATE INDEX IF NOT EXISTS idx_qbank_answers_user_q   ON qbank_user_answers(user_id, question_id);

-- 3. Bookmarks table
CREATE TABLE IF NOT EXISTS qbank_bookmarks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id),
  question_id   UUID NOT NULL REFERENCES qbank_questions(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_qbank_bookmarks_user ON qbank_bookmarks(user_id);

-- ============================================================
-- RLS Policies
-- ============================================================

ALTER TABLE qbank_questions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbank_user_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbank_bookmarks   ENABLE ROW LEVEL SECURITY;

-- Questions: everyone can read published; admins can do everything
CREATE POLICY "qbank_questions_read" ON qbank_questions
  FOR SELECT USING (status = 'published' OR auth.uid() IN (
    SELECT id FROM profiles WHERE role IN ('admin','super_admin','owner')
  ));

CREATE POLICY "qbank_questions_admin_insert" ON qbank_questions
  FOR INSERT WITH CHECK (auth.uid() IN (
    SELECT id FROM profiles WHERE role IN ('admin','super_admin','owner')
  ));

CREATE POLICY "qbank_questions_admin_update" ON qbank_questions
  FOR UPDATE USING (auth.uid() IN (
    SELECT id FROM profiles WHERE role IN ('admin','super_admin','owner')
  ));

CREATE POLICY "qbank_questions_admin_delete" ON qbank_questions
  FOR DELETE USING (auth.uid() IN (
    SELECT id FROM profiles WHERE role IN ('admin','super_admin','owner')
  ));

-- Answers: users see only their own
CREATE POLICY "qbank_answers_own_select" ON qbank_user_answers
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "qbank_answers_own_insert" ON qbank_user_answers
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Bookmarks: users see only their own
CREATE POLICY "qbank_bookmarks_own_select" ON qbank_bookmarks
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "qbank_bookmarks_own_insert" ON qbank_bookmarks
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "qbank_bookmarks_own_delete" ON qbank_bookmarks
  FOR DELETE USING (auth.uid() = user_id);
