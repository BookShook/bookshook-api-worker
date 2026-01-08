-- ============================================================================
-- 004_vault_taxonomy_updates.sql
-- BookShook Vault: Enhanced Taxonomy for Production Vault UI
-- ============================================================================

BEGIN;

-- Add is_premium column to tag_categories if not exists
ALTER TABLE tag_categories
  ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE;

-- Update required axes to be single-select
UPDATE tag_categories SET single_select = TRUE
WHERE key IN ('world_framework', 'pairing', 'heat_level', 'series_status', 'consent_mode');

-- Mark premium categories
UPDATE tag_categories SET is_premium = TRUE
WHERE key IN ('consent_mode', 'kink_bundle', 'kink_detail', 'hero_kink');

-- Insert/update tag categories with proper settings
INSERT INTO tag_categories (key, label, single_select, is_premium, display_order, sensitive_by_default)
VALUES
  -- Required Axes
  ('world_framework', 'World', TRUE, FALSE, 1, FALSE),
  ('pairing', 'Pairing', TRUE, FALSE, 2, FALSE),
  ('heat_level', 'Heat Level', TRUE, FALSE, 3, FALSE),
  ('series_status', 'Series Status', TRUE, FALSE, 4, FALSE),
  ('consent_mode', 'Consent Framing', TRUE, TRUE, 5, FALSE),

  -- Safety
  ('safety', 'Safety Shields', FALSE, FALSE, 10, FALSE),

  -- Tone
  ('tone', 'Tone & Vibe', FALSE, FALSE, 20, FALSE),

  -- Tropes
  ('trope_relationship', 'Relationship Dynamics', FALSE, FALSE, 30, FALSE),
  ('trope_power', 'Power & Protection', FALSE, FALSE, 31, FALSE),
  ('trope_emotional', 'Emotional Engines', FALSE, FALSE, 32, FALSE),
  ('trope_situation', 'Life Situation', FALSE, FALSE, 33, FALSE),
  ('trope_structure', 'Structure & Intimacy', FALSE, FALSE, 34, FALSE),

  -- Heroes
  ('hero_classic', 'Classic Hero Types', FALSE, FALSE, 40, FALSE),
  ('hero_specialized', 'Specialized Hero Types', FALSE, FALSE, 41, FALSE),
  ('hero_professional', 'Professional Hero Types', FALSE, FALSE, 42, FALSE),
  ('hero_kink', 'Kink-Adjacent Heroes', FALSE, TRUE, 43, FALSE),

  -- Heroines
  ('heroine_core', 'Core Heroine Types', FALSE, FALSE, 50, FALSE),
  ('heroine_situation', 'Heroine Situations', FALSE, FALSE, 51, FALSE),
  ('heroine_dynamic', 'Dynamic Heroines', FALSE, FALSE, 52, FALSE),

  -- Setting & Atmosphere
  ('setting', 'Setting', FALSE, FALSE, 60, FALSE),
  ('aesthetic', 'Aesthetic', FALSE, FALSE, 61, FALSE),
  ('seasonal', 'Season / Holiday', FALSE, FALSE, 62, FALSE),
  ('plot_engine', 'Plot Engine', FALSE, FALSE, 63, FALSE),
  ('life_stage', 'Life Stage', FALSE, FALSE, 64, FALSE),

  -- Representation
  ('rep_orientation', 'Sexual Orientation', FALSE, FALSE, 70, FALSE),
  ('rep_gender', 'Gender Identity', FALSE, FALSE, 71, FALSE),
  ('rep_relationship', 'Relationship Structure', FALSE, FALSE, 72, FALSE),
  ('rep_physical', 'Physical Disability', FALSE, FALSE, 73, FALSE),
  ('rep_chronic', 'Chronic Illness', FALSE, FALSE, 74, FALSE),
  ('rep_neuro', 'Neurodivergence', FALSE, FALSE, 75, FALSE),
  ('rep_mental_health', 'Mental Health', FALSE, FALSE, 76, FALSE),
  ('rep_body', 'Body Representation', FALSE, FALSE, 77, FALSE),
  ('rep_culture', 'Race & Culture', FALSE, FALSE, 78, FALSE),
  ('rep_religion', 'Religion', FALSE, FALSE, 79, FALSE),
  ('rep_background', 'Background', FALSE, FALSE, 80, FALSE),

  -- Kinks
  ('kink_bundle', 'Spice Categories', FALSE, TRUE, 90, FALSE),
  ('kink_detail', 'Kink Details', FALSE, TRUE, 91, TRUE),

  -- Content Warnings
  ('content_warning', 'Content Warnings', FALSE, FALSE, 100, FALSE)

ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  single_select = EXCLUDED.single_select,
  is_premium = EXCLUDED.is_premium,
  display_order = EXCLUDED.display_order;

-- Insert heat level tags with updated language
INSERT INTO tags (id, slug, name, category, display_order)
VALUES
  (gen_random_uuid(), 'hl_1', 'Closed Door', 'heat_level', 1),
  (gen_random_uuid(), 'hl_2', 'Ajar', 'heat_level', 2),
  (gen_random_uuid(), 'hl_3', 'Open Door', 'heat_level', 3),
  (gen_random_uuid(), 'hl_4', 'Wide Open', 'heat_level', 4),
  (gen_random_uuid(), 'hl_5', 'Blazing', 'heat_level', 5)
ON CONFLICT ON CONSTRAINT idx_tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name;

-- Insert safety shield tags
INSERT INTO tags (id, slug, name, category, description, display_order)
VALUES
  (gen_random_uuid(), 'guaranteed_hea', 'Guaranteed HEA', 'safety', 'Happily ever after confirmed', 1),
  (gen_random_uuid(), 'no_cliffhanger', 'No Cliffhanger', 'safety', 'Complete story arc', 2),
  (gen_random_uuid(), 'no_cheating', 'No Cheating', 'safety', 'Zero infidelity', 3),
  (gen_random_uuid(), 'no_ow_om', 'No OW/OM Drama', 'safety', 'No third-party romantic conflict', 4),
  (gen_random_uuid(), 'no_abuse', 'No Abuse Depicted', 'safety', 'No abuse on page', 5),
  (gen_random_uuid(), 'no_sexual_violence', 'No SA', 'safety', 'No sexual assault', 6),
  (gen_random_uuid(), 'no_character_death', 'No Character Death', 'safety', 'Everyone lives', 7),
  (gen_random_uuid(), 'pet_survives', 'Pet Survives', 'safety', 'Fur babies safe', 8),
  (gen_random_uuid(), 'enthusiastic_consent', 'Enthusiastic Consent', 'safety', 'Clear mutual desire throughout', 9),
  (gen_random_uuid(), 'low_angst', 'Low Angst', 'safety', 'Comfort read vibes', 10),
  (gen_random_uuid(), 'good_communication', 'Good Communication', 'safety', 'Characters who actually talk', 11)
ON CONFLICT ON CONSTRAINT idx_tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

COMMIT;
