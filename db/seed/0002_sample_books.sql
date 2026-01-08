-- 0002_sample_books.sql
-- Optional sample book so /api/books returns something immediately.

-- Author
INSERT INTO authors (name, slug)
VALUES ('Jane Doe', 'jane-doe')
ON CONFLICT (slug) DO NOTHING;

-- Book
INSERT INTO books (slug, title, subtitle, description, cover_url, published_year, page_count)
VALUES (
  'sample-book-1',
  'Sample Book One',
  'A Demo Subtitle',
  'This is a demo description for testing /api/books.',
  NULL,
  2024,
  350
)
ON CONFLICT (slug) DO NOTHING;

-- Link author
INSERT INTO book_authors (book_id, author_id, author_order)
SELECT b.id, a.id, 1
FROM books b
JOIN authors a ON a.slug = 'jane-doe'
WHERE b.slug = 'sample-book-1'
ON CONFLICT (book_id, author_id) DO NOTHING;

-- Link tags (uses your existing seeded tags)
INSERT INTO book_tags (book_id, tag_id)
SELECT b.id, t.id
FROM books b
JOIN tags t ON t.slug IN ('contemporary', 'm-f', 'hl-3')
WHERE b.slug = 'sample-book-1'
ON CONFLICT (book_id, tag_id) DO NOTHING;
