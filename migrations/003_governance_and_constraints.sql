-- ============================================================================
-- Migration 003: Evidence/Quote Governance + Database Constraints
-- ============================================================================
-- This migration adds:
-- 1. Evidence governance fields (visibility, spoiler levels, char limits)
-- 2. Standout quotes governance fields
-- 3. Database constraints for data integrity
-- 4. Actor typing for events table
-- 5. Foreign key constraints for evidence_links
-- ============================================================================

-- ============================================================================
-- PART 1: EVIDENCE GOVERNANCE
-- ============================================================================
-- These fields control how evidence can be used/distributed

-- Create enum types for governance
DO $$ BEGIN
  CREATE TYPE evidence_visibility AS ENUM (
    'internal_only',    -- Only visible in curator workbench
    'member_safe',      -- Can be shown to logged-in members
    'email_ok',         -- Can be included in email campaigns
    'author_safe'       -- Can be shared with the author
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE spoiler_level AS ENUM (
    'none',             -- No spoilers
    'mild',             -- Minor plot points revealed
    'major'             -- Major plot twists/endings revealed
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE quote_policy_status AS ENUM (
    'ok',               -- Within limits, approved
    'too_long',         -- Exceeds character limit
    'blocked',          -- Blocked from distribution
    'needs_redaction'   -- Contains content that needs redaction
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Add governance columns to evidence table
ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS visibility evidence_visibility DEFAULT 'internal_only',
  ADD COLUMN IF NOT EXISTS spoiler spoiler_level DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS char_count INT GENERATED ALWAYS AS (LENGTH(COALESCE(quote_text, ''))) STORED,
  ADD COLUMN IF NOT EXISTS policy_status quote_policy_status DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS redacted_text TEXT,
  ADD COLUMN IF NOT EXISTS policy_notes TEXT;

-- Add governance columns to standout_quotes table
ALTER TABLE standout_quotes
  ADD COLUMN IF NOT EXISTS visibility evidence_visibility DEFAULT 'internal_only',
  ADD COLUMN IF NOT EXISTS spoiler spoiler_level DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS char_count INT GENERATED ALWAYS AS (LENGTH(COALESCE(quote_text, ''))) STORED,
  ADD COLUMN IF NOT EXISTS policy_status quote_policy_status DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS redacted_text TEXT,
  ADD COLUMN IF NOT EXISTS policy_notes TEXT;

-- Create function to auto-check policy status based on char count
CREATE OR REPLACE FUNCTION check_quote_policy()
RETURNS TRIGGER AS $$
BEGIN
  -- Evidence quotes: max 280 chars for distribution
  IF TG_TABLE_NAME = 'evidence' THEN
    IF NEW.visibility IN ('email_ok', 'member_safe') AND LENGTH(COALESCE(NEW.quote_text, '')) > 280 THEN
      NEW.policy_status := 'too_long';
    END IF;
  END IF;

  -- Standout quotes for email: max 180 chars
  IF TG_TABLE_NAME = 'standout_quotes' THEN
    IF NEW.use_in_drop_email = TRUE AND LENGTH(COALESCE(NEW.quote_text, '')) > 180 THEN
      NEW.policy_status := 'too_long';
    END IF;
  END IF;

  -- Block distribution of major spoilers unless explicitly overridden
  IF NEW.spoiler = 'major' AND NEW.visibility != 'internal_only' AND NEW.policy_notes IS NULL THEN
    NEW.policy_status := 'blocked';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to evidence
DROP TRIGGER IF EXISTS evidence_policy_check ON evidence;
CREATE TRIGGER evidence_policy_check
  BEFORE INSERT OR UPDATE ON evidence
  FOR EACH ROW
  EXECUTE FUNCTION check_quote_policy();

-- Apply trigger to standout_quotes
DROP TRIGGER IF EXISTS standout_quotes_policy_check ON standout_quotes;
CREATE TRIGGER standout_quotes_policy_check
  BEFORE INSERT OR UPDATE ON standout_quotes
  FOR EACH ROW
  EXECUTE FUNCTION check_quote_policy();

-- ============================================================================
-- PART 2: DATABASE CONSTRAINTS
-- ============================================================================

-- 2a. Unique ASIN constraint (partial index - only non-null values)
-- This prevents duplicate books with the same ASIN
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_identifiers_asin_unique
  ON book_identifiers (asin)
  WHERE asin IS NOT NULL;

-- 2b. Unique ISBN13 constraint (partial index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_identifiers_isbn13_unique
  ON book_identifiers (isbn13)
  WHERE isbn13 IS NOT NULL;

-- ============================================================================
-- PART 3: ACTOR TYPING FOR EVENTS
-- ============================================================================
-- Replace free-text actor_id with proper typing

-- Create actor type enum
DO $$ BEGIN
  CREATE TYPE actor_type AS ENUM (
    'system',           -- Automated system actions
    'curator',          -- Admin/curator actions
    'author',           -- Author portal actions
    'member'            -- Member actions (voting, etc.)
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Add typed columns to events (keep old actor_id for migration)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS actor_type actor_type,
  ADD COLUMN IF NOT EXISTS actor_ref UUID;

-- Migrate existing data
UPDATE events
SET actor_type = CASE
  WHEN actor_id = 'system' THEN 'system'::actor_type
  WHEN actor_id = 'curator' THEN 'curator'::actor_type
  WHEN actor_id ~ '^[0-9a-fA-F-]{36}$' THEN 'author'::actor_type
  ELSE 'system'::actor_type
END
WHERE actor_type IS NULL;

-- Set default for new rows
ALTER TABLE events
  ALTER COLUMN actor_type SET DEFAULT 'system';

-- ============================================================================
-- PART 4: EVIDENCE LINKS FOREIGN KEY CONSTRAINTS
-- ============================================================================
-- Ensure evidence_links point to valid targets

-- For tag targets, add FK to tags table
-- Note: This is a partial constraint - only enforced when target_type = 'tag'
-- We use a trigger instead of FK for flexibility

CREATE OR REPLACE FUNCTION validate_evidence_link()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.target_type = 'tag' THEN
    IF NOT EXISTS (SELECT 1 FROM tags WHERE id = NEW.target_id) THEN
      RAISE EXCEPTION 'Invalid target_id: tag % does not exist', NEW.target_id;
    END IF;
  END IF;

  -- For axis targets, validate it's a valid axis tag
  IF NEW.target_type = 'axis' THEN
    IF NOT EXISTS (
      SELECT 1 FROM tags t
      JOIN tag_categories tc ON tc.key = t.category
      WHERE t.id = NEW.target_id AND tc.single_select = TRUE
    ) THEN
      RAISE EXCEPTION 'Invalid target_id: axis tag % does not exist or is not single-select', NEW.target_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_link_validation ON evidence_links;
CREATE TRIGGER evidence_link_validation
  BEFORE INSERT OR UPDATE ON evidence_links
  FOR EACH ROW
  EXECUTE FUNCTION validate_evidence_link();

-- ============================================================================
-- PART 5: INDEXES FOR GOVERNANCE QUERIES
-- ============================================================================

-- Index for finding evidence by visibility
CREATE INDEX IF NOT EXISTS idx_evidence_visibility ON evidence (visibility);

-- Index for finding quotes needing policy review
CREATE INDEX IF NOT EXISTS idx_evidence_policy_status ON evidence (policy_status)
  WHERE policy_status != 'ok';

CREATE INDEX IF NOT EXISTS idx_standout_quotes_policy_status ON standout_quotes (policy_status)
  WHERE policy_status != 'ok';

-- Index for spoiler level filtering
CREATE INDEX IF NOT EXISTS idx_evidence_spoiler ON evidence (spoiler)
  WHERE spoiler != 'none';

-- ============================================================================
-- VERIFICATION QUERIES (run manually to verify migration)
-- ============================================================================
--
-- Check evidence governance columns:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'evidence' AND column_name IN ('visibility', 'spoiler', 'policy_status');
--
-- Check ASIN uniqueness:
-- SELECT asin, COUNT(*) FROM book_identifiers WHERE asin IS NOT NULL GROUP BY asin HAVING COUNT(*) > 1;
--
-- Check actor typing migration:
-- SELECT actor_type, COUNT(*) FROM events GROUP BY actor_type;
--
-- ============================================================================
