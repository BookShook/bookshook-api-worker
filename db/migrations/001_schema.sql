-- ============================================================================
-- 001_schema.sql
-- BookShook Vault: Schema Extensions
--
-- Extends the existing database with:
--   - Additional columns for users table
--   - Additional columns for books table (metadata fields)
--   - tag_categories table for taxonomy
--   - Additional columns for tags table
--   - user_interactions table for hearts, saves, TBR
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Users table extensions
-- ----------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS is_paid BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ----------------------------------------------------------------------------
-- Books table extensions (metadata fields)
-- ----------------------------------------------------------------------------
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS asin TEXT,
  ADD COLUMN IF NOT EXISTS isbn TEXT,
  ADD COLUMN IF NOT EXISTS author_name TEXT,
  ADD COLUMN IF NOT EXISTS author_id UUID,
  ADD COLUMN IF NOT EXISTS series_name TEXT,
  ADD COLUMN IF NOT EXISTS series_position NUMERIC,
  ADD COLUMN IF NOT EXISTS amazon_url TEXT,
  ADD COLUMN IF NOT EXISTS goodreads_url TEXT,
  ADD COLUMN IF NOT EXISTS publication_date DATE,
  ADD COLUMN IF NOT EXISTS publisher TEXT,
  ADD COLUMN IF NOT EXISTS kindle_unlimited BOOLEAN,
  ADD COLUMN IF NOT EXISTS amazon_rating NUMERIC(3,1),
  ADD COLUMN IF NOT EXISTS amazon_review_count INT,
  ADD COLUMN IF NOT EXISTS goodreads_rating NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS goodreads_review_count INT,
  ADD COLUMN IF NOT EXISTS content_warnings TEXT[],
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_books_asin ON books(asin);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author_name);
CREATE INDEX IF NOT EXISTS idx_books_kindle_unlimited ON books(kindle_unlimited);
CREATE INDEX IF NOT EXISTS idx_books_amazon_rating ON books(amazon_rating);

-- Create unique index on asin if not exists (can't use IF NOT EXISTS with UNIQUE)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_books_asin_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_books_asin_unique ON books(asin) WHERE asin IS NOT NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Authors table extensions
-- ----------------------------------------------------------------------------
ALTER TABLE authors
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS website_url TEXT,
  ADD COLUMN IF NOT EXISTS amazon_author_url TEXT,
  ADD COLUMN IF NOT EXISTS goodreads_author_url TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ----------------------------------------------------------------------------
-- Tag Categories (taxonomy structure) - NEW TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tag_categories (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  single_select BOOLEAN NOT NULL DEFAULT FALSE,
  sensitive_by_default BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INT NOT NULL DEFAULT 0
);

-- ----------------------------------------------------------------------------
-- Tags table extensions
-- ----------------------------------------------------------------------------
ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS parent_tag_id UUID,
  ADD COLUMN IF NOT EXISTS sensitive_flag BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Add foreign key to tag_categories if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_tags_category' AND table_name = 'tags'
  ) THEN
    ALTER TABLE tags ADD CONSTRAINT fk_tags_category
      FOREIGN KEY (category) REFERENCES tag_categories(key) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN
  -- Ignore if constraint can't be added (e.g., data violates it)
  NULL;
END $$;

-- Add self-referential FK for parent tags
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_tags_parent' AND table_name = 'tags'
  ) THEN
    ALTER TABLE tags ADD CONSTRAINT fk_tags_parent
      FOREIGN KEY (parent_tag_id) REFERENCES tags(id) ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN others THEN
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_tags_category ON tags(category);
CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_tag_id);

-- Add unique constraint on (category, slug)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_tags_category_slug_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_tags_category_slug_unique ON tags(category, slug)
      WHERE category IS NOT NULL AND slug IS NOT NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Book-Tags extensions
-- ----------------------------------------------------------------------------
ALTER TABLE book_tags
  ADD COLUMN IF NOT EXISTS added_by UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Add FK to users for added_by
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_book_tags_added_by' AND table_name = 'book_tags'
  ) THEN
    ALTER TABLE book_tags ADD CONSTRAINT fk_book_tags_added_by
      FOREIGN KEY (added_by) REFERENCES users(ghost_member_id) ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN others THEN
  NULL;
END $$;

-- ----------------------------------------------------------------------------
-- User Interactions (hearts, saves, TBR, blacklists) - NEW TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghost_member_id UUID NOT NULL REFERENCES users(ghost_member_id) ON DELETE CASCADE,
  book_id UUID REFERENCES books(id) ON DELETE CASCADE,
  author_id UUID,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('heart', 'save', 'tbr', 'blacklist_book', 'blacklist_author')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ghost_member_id, book_id, interaction_type)
);

CREATE INDEX IF NOT EXISTS idx_interactions_member ON user_interactions(ghost_member_id);
CREATE INDEX IF NOT EXISTS idx_interactions_book ON user_interactions(book_id);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON user_interactions(interaction_type);
CREATE INDEX IF NOT EXISTS idx_interactions_member_type ON user_interactions(ghost_member_id, interaction_type);

-- ----------------------------------------------------------------------------
-- Collections extensions
-- ----------------------------------------------------------------------------
ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_collections_published ON collections(is_published);

-- ----------------------------------------------------------------------------
-- Collection-Books extensions
-- ----------------------------------------------------------------------------
ALTER TABLE collection_books
  ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ----------------------------------------------------------------------------
-- Updated_at trigger function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers to tables with updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_books_updated_at ON books;
CREATE TRIGGER update_books_updated_at
  BEFORE UPDATE ON books
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_authors_updated_at ON authors;
CREATE TRIGGER update_authors_updated_at
  BEFORE UPDATE ON authors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_collections_updated_at ON collections;
CREATE TRIGGER update_collections_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
