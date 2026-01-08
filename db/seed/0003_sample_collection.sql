-- 0003_sample_collection.sql
-- Creates a sample collection that includes your sample book.

INSERT INTO collections (slug, title, description, cover_url)
VALUES ('staff-picks', 'Staff Picks', 'A small set of books to validate /api/collections.', NULL)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO collection_books (collection_id, book_id, book_order)
SELECT c.id, b.id, 1
FROM collections c
JOIN books b ON b.slug = 'sample-book-1'
WHERE c.slug = 'staff-picks'
ON CONFLICT (collection_id, book_id) DO NOTHING;
