-- ------------------------------------------------------------
-- Author Portal (Day-1): Authors can submit ONLY existing tags with evidence.
-- Curator reviews + approves to apply tags to books.
-- ------------------------------------------------------------

-- Drop old tables if they exist with wrong schema (safe since they're empty)
DROP TABLE IF EXISTS author_tag_submissions CASCADE;
DROP TABLE IF EXISTS author_portal_tokens CASCADE;
DROP TABLE IF EXISTS author_portal_accounts CASCADE;

CREATE TABLE IF NOT EXISTS author_portal_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One-time invite tokens (store SHA-256 hash only)
CREATE TABLE IF NOT EXISTS author_portal_tokens (
  token_hash TEXT PRIMARY KEY,
  author_account_id UUID NOT NULL REFERENCES author_portal_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_author_portal_tokens_expires ON author_portal_tokens(expires_at);

-- Author submissions (existing tags only)
CREATE TABLE IF NOT EXISTS author_tag_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_account_id UUID NOT NULL REFERENCES author_portal_accounts(id) ON DELETE CASCADE,
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,

  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewer_notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (author_account_id, book_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_author_tag_submissions_status ON author_tag_submissions(status);
CREATE INDEX IF NOT EXISTS idx_author_tag_submissions_book ON author_tag_submissions(book_id);
CREATE INDEX IF NOT EXISTS idx_author_tag_submissions_author ON author_tag_submissions(author_account_id);

-- optional: updated_at trigger (if you already have set_updated_at() helper, reuse it)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_author_tag_submissions_updated_at') THEN
      CREATE TRIGGER trg_author_tag_submissions_updated_at
      BEFORE UPDATE ON author_tag_submissions
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
    END IF;
  END IF;
END $$;
