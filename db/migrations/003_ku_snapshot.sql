-- ============================================================================
-- 003_ku_snapshot.sql
-- BookShook Vault: KU-at-intake snapshot + community KU confirmation (Day-1)
--
-- Operating System Truth #1/#2:
--  - "Hidden Gem" status is an intake snapshot (immutable facts)
--  - Do not promise "still on KU" without timestamps; treat current KU as a signal
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Intake snapshot fields (immutable facts)
-- ----------------------------------------------------------------------------
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS ku_at_intake BOOLEAN,
  ADD COLUMN IF NOT EXISTS reviews_at_intake INT,
  ADD COLUMN IF NOT EXISTS intake_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intake_checked_by UUID REFERENCES users(ghost_member_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS intake_source TEXT; -- e.g. 'amazon_page', 'manual'

-- Optional: keep current fields but clarify semantics
-- kindle_unlimited/goodreads_review_count/amazon_review_count can remain "last_known"
-- while ku_at_intake/reviews_at_intake are immutable provenance.

-- ----------------------------------------------------------------------------
-- Community "current KU" signal (optional but recommended)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ku_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghost_member_id UUID NOT NULL REFERENCES users(ghost_member_id) ON DELETE CASCADE,
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  vote_on_ku BOOLEAN NOT NULL,                 -- TRUE = "still on KU", FALSE = "not on KU"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ku_conf_book_created ON ku_confirmations(book_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ku_conf_member_book ON ku_confirmations(ghost_member_id, book_id);

-- A lightweight view for UI badges (30-day window)
CREATE OR REPLACE VIEW book_ku_signal_30d AS
WITH recent AS (
  SELECT
    book_id,
    vote_on_ku,
    created_at
  FROM ku_confirmations
  WHERE created_at >= NOW() - INTERVAL '30 days'
),
agg AS (
  SELECT
    book_id,
    COUNT(*) FILTER (WHERE vote_on_ku = TRUE)  AS yes_count_30d,
    COUNT(*) FILTER (WHERE vote_on_ku = FALSE) AS no_count_30d,
    MAX(created_at) FILTER (WHERE vote_on_ku = TRUE)  AS last_confirmed_on,
    MAX(created_at) FILTER (WHERE vote_on_ku = FALSE) AS last_confirmed_off
  FROM recent
  GROUP BY book_id
)
SELECT
  b.id AS book_id,
  COALESCE(a.yes_count_30d, 0) AS yes_count_30d,
  COALESCE(a.no_count_30d, 0)  AS no_count_30d,
  a.last_confirmed_on,
  a.last_confirmed_off,
  CASE
    WHEN COALESCE(a.yes_count_30d, 0) = 0 AND COALESCE(a.no_count_30d, 0) = 0 THEN 'unknown'
    WHEN COALESCE(a.yes_count_30d, 0) >= COALESCE(a.no_count_30d, 0) * 2 AND COALESCE(a.yes_count_30d, 0) >= 3 THEN 'likely_on_ku'
    WHEN COALESCE(a.no_count_30d, 0) >= COALESCE(a.yes_count_30d, 0) * 2 AND COALESCE(a.no_count_30d, 0) >= 3 THEN 'likely_not_on_ku'
    ELSE 'disputed'
  END AS ku_current_state_30d
FROM books b
LEFT JOIN agg a ON a.book_id = b.id;

COMMIT;
