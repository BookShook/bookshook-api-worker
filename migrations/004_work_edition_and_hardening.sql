-- ============================================================================
-- Migration 004: Work/Edition Groundwork + System Hardening
-- ============================================================================
-- This migration adds:
-- 1. Work/Edition identity model foundation (work_id on books)
-- 2. Publication tracking (last_published_publication_id, diff support)
-- 3. Session revocation infrastructure (for JTI-based invalidation)
-- 4. Hard constraints for standout quotes
-- 5. Publish invariant constraints
-- ============================================================================

-- ============================================================================
-- PART 1: WORK/EDITION IDENTITY MODEL (Option B - minimal groundwork)
-- ============================================================================
-- This allows future "merge editions" by assigning same work_id to multiple books.
-- For now, work_id can be NULL (each book is its own work).
-- When editions are merged, they share work_id, and tags/curation lives on work.

-- Works table (canonical story entity)
CREATE TABLE IF NOT EXISTS works (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_title TEXT NOT NULL,
  canonical_slug TEXT NOT NULL UNIQUE,
  series_name TEXT,
  series_position TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add work_id to books (nullable - books without work_id are standalone)
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS work_id UUID REFERENCES works(id) ON DELETE SET NULL;

-- Index for finding all editions of a work
CREATE INDEX IF NOT EXISTS idx_books_work_id ON books (work_id)
  WHERE work_id IS NOT NULL;

-- ============================================================================
-- PART 2: PUBLICATION TRACKING (for diffs and re-publish workflow)
-- ============================================================================

-- Track which publication is currently "live" for each book
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS last_published_publication_id UUID REFERENCES book_publications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_published_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS last_published_at TIMESTAMP WITH TIME ZONE;

-- Track previous publication for diff computation
ALTER TABLE book_publications
  ADD COLUMN IF NOT EXISTS previous_publication_id UUID REFERENCES book_publications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS diff_summary_json JSONB;

-- Index for efficient diff queries
CREATE INDEX IF NOT EXISTS idx_book_publications_book_id ON book_publications (book_id, published_at DESC);

-- ============================================================================
-- PART 3: SESSION REVOCATION INFRASTRUCTURE
-- ============================================================================
-- Supports "log out all devices" and forced session invalidation

CREATE TABLE IF NOT EXISTS session_revocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Either a specific JTI or a user-wide revocation
  jti TEXT,                            -- specific session ID to revoke (NULL = all sessions)
  subject TEXT NOT NULL,               -- 'curator', author account id, etc.
  revoked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  revoked_by TEXT,                     -- who initiated revocation
  reason TEXT,                         -- why revoked
  -- For user-wide revocation, sessions issued before this time are invalid
  revoke_sessions_before TIMESTAMP WITH TIME ZONE
);

-- Index for efficient JTI lookup
CREATE INDEX IF NOT EXISTS idx_session_revocations_jti ON session_revocations (jti)
  WHERE jti IS NOT NULL;

-- Index for subject-wide revocation lookup
CREATE INDEX IF NOT EXISTS idx_session_revocations_subject ON session_revocations (subject, revoke_sessions_before DESC);

-- ============================================================================
-- PART 4: HARD CONSTRAINTS FOR STANDOUT QUOTES
-- ============================================================================
-- Enforce max 2 standout quotes per book at DB level

-- Create a function to enforce the limit
CREATE OR REPLACE FUNCTION enforce_standout_quote_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM standout_quotes WHERE book_id = NEW.book_id) >= 2 THEN
    RAISE EXCEPTION 'Maximum 2 standout quotes per book (book_id: %)', NEW.book_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger
DROP TRIGGER IF EXISTS standout_quote_limit_check ON standout_quotes;
CREATE TRIGGER standout_quote_limit_check
  BEFORE INSERT ON standout_quotes
  FOR EACH ROW
  EXECUTE FUNCTION enforce_standout_quote_limit();

-- ============================================================================
-- PART 5: PUBLISH INVARIANT CONSTRAINTS
-- ============================================================================
-- Ensure published books meet minimum requirements

-- Function to validate publish requirements
CREATE OR REPLACE FUNCTION validate_publish_requirements()
RETURNS TRIGGER AS $$
BEGIN
  -- Only check when transitioning to published
  IF NEW.status = 'published' AND (OLD.status IS NULL OR OLD.status != 'published') THEN
    -- Check required axes exist
    IF NOT EXISTS (
      SELECT 1 FROM book_axes ba
      WHERE ba.book_id = NEW.id
        AND ba.world_framework_tag_id IS NOT NULL
        AND ba.pairing_tag_id IS NOT NULL
        AND ba.heat_level_tag_id IS NOT NULL
        AND ba.series_status_tag_id IS NOT NULL
        AND ba.consent_mode_tag_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Cannot publish: missing required axes for book %', NEW.id;
    END IF;

    -- Check cover exists
    IF NOT EXISTS (
      SELECT 1 FROM book_assets
      WHERE book_id = NEW.id AND asset_type = 'cover' AND state = 'ready'
    ) THEN
      RAISE EXCEPTION 'Cannot publish: no ready cover for book %', NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger
DROP TRIGGER IF EXISTS publish_requirements_check ON books;
CREATE TRIGGER publish_requirements_check
  BEFORE UPDATE ON books
  FOR EACH ROW
  EXECUTE FUNCTION validate_publish_requirements();

-- ============================================================================
-- PART 6: ASSET REPROCESS TRACKING
-- ============================================================================
-- Track reprocessing requests for covers

ALTER TABLE book_assets
  ADD COLUMN IF NOT EXISTS reprocess_requested_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS reprocess_requested_by TEXT,
  ADD COLUMN IF NOT EXISTS reprocess_source_version INT,
  ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT 'ready';

-- ============================================================================
-- VERIFICATION QUERIES (run manually)
-- ============================================================================
--
-- Check work_id column:
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'books' AND column_name = 'work_id';
--
-- Check session_revocations table:
-- SELECT * FROM session_revocations LIMIT 5;
--
-- Test standout quote limit:
-- INSERT INTO standout_quotes (book_id, quote_label, quote_text, created_by)
-- VALUES ('some-uuid', 'funny', 'Test', 'test');
-- (should fail if book already has 2 quotes)
--
-- Test publish constraint:
-- UPDATE books SET status = 'published' WHERE id = 'book-without-axes';
-- (should fail)
--
-- ============================================================================
