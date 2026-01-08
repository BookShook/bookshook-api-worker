-- 0003_collections.sql
-- Adds: collections, collection_books

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  cover_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collections_title_idx ON collections(title);

CREATE TABLE IF NOT EXISTS collection_books (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  book_order INT NOT NULL DEFAULT 1,
  PRIMARY KEY (collection_id, book_id)
);

CREATE INDEX IF NOT EXISTS collection_books_collection_id_idx ON collection_books(collection_id);
CREATE INDEX IF NOT EXISTS collection_books_book_id_idx ON collection_books(book_id);
CREATE INDEX IF NOT EXISTS collection_books_order_idx ON collection_books(collection_id, book_order);
