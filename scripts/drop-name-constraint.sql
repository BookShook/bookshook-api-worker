-- Drop the tags_category_name_unique constraint
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_category_name_unique;

-- Also drop any index with that name
DROP INDEX IF EXISTS tags_category_name_unique;

-- Verify remaining constraints
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'tags'::regclass;

-- Verify remaining indexes
SELECT indexname
FROM pg_indexes
WHERE tablename = 'tags' AND indexname LIKE '%name%';
