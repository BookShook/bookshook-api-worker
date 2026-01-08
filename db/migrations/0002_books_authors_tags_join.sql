-- 0002_books_authors_tags_join.sql
-- Adds: books, authors, book_authors, book_tags
-- Also enables pg_trgm for fuzzy search.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AUTHORS
CREATE TABLE IF NOT EXISTS authors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- BOOKS
CREATE TABLE IF NOT EXISTS books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT,
  description TEXT,
  cover_url TEXT,
  published_year INT,
  page_count INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Join: BOOK_AUTHORS (many-to-many)
CREATE TABLE IF NOT EXISTS book_authors (
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  author_order INT NOT NULL DEFAULT 1,
  PRIMARY KEY (book_id, author_id)
);

CREATE INDEX IF NOT EXISTS book_authors_book_id_idx ON book_authors(book_id);
CREATE INDEX IF NOT EXISTS book_authors_author_id_idx ON book_authors(author_id);

-- Join: BOOK_TAGS (many-to-many)
-- Assumes tags(id) already exists from 0001.
CREATE TABLE IF NOT EXISTS book_tags (
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);

CREATE INDEX IF NOT EXISTS book_tags_book_id_idx ON book_tags(book_id);
CREATE INDEX IF NOT EXISTS book_tags_tag_id_idx ON book_tags(tag_id);

-- Fuzzy search indexes (pg_trgm)
CREATE INDEX IF NOT EXISTS books_title_trgm_idx
  ON books USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS books_subtitle_trgm_idx
  ON books USING GIN (subtitle gin_trgm_ops);

CREATE INDEX IF NOT EXISTS authors_name_trgm_idx
  ON authors USING GIN (name gin_trgm_ops);

-- Helpful sort indexes
CREATE INDEX IF NOT EXISTS books_created_at_idx ON books(created_at DESC);
CREATE INDEX IF NOT EXISTS books_title_idx ON books(title);
