-- ============================================================================
-- 002_taxonomy_seed.sql
-- BookShook Vault: Full Taxonomy Seed (v3.1)
-- Canonical: taxonomy is DATA in tags table (not enums).
--
-- This migration:
--  1) Upserts tag_categories
--  2) Upserts tags with parent_tag_id=NULL
--  3) Sets parent_tag_id for kink_detail -> kink_bundle via parent_slug
--  4) Runs sanity checks (counts, duplicates, parenting)
-- ============================================================================

BEGIN;

-- Seed data in temp tables (session-scoped)
CREATE TEMP TABLE _seed_tag_categories (
  key TEXT,
  label TEXT,
  single_select BOOLEAN,
  sensitive_by_default BOOLEAN,
  display_order INT
) ON COMMIT DROP;

INSERT INTO _seed_tag_categories (key, label, single_select, sensitive_by_default, display_order)
VALUES
  ('world_framework', 'World Framework', TRUE, FALSE, 1),
  ('pairing', 'Pairing', TRUE, FALSE, 2),
  ('heat_level', 'Heat Level', TRUE, FALSE, 3),
  ('series_status', 'Series Status', TRUE, FALSE, 4),
  ('consent_mode', 'Consent Mode', TRUE, FALSE, 5),
  ('tone', 'Tone', FALSE, FALSE, 10),
  ('plot_engine', 'Plot Engine', FALSE, FALSE, 11),
  ('setting_wrapper', 'Setting Wrapper', FALSE, FALSE, 12),
  ('seasonal_wrapper', 'Seasonal Wrapper', FALSE, FALSE, 13),
  ('aesthetic_atmosphere', 'Aesthetic / Atmosphere', FALSE, FALSE, 14),
  ('market_life_stage', 'Market / Life Stage', FALSE, FALSE, 15),
  ('trope', 'Trope', FALSE, FALSE, 16),
  ('hero_archetype', 'Hero Archetype', FALSE, FALSE, 17),
  ('heroine_archetype', 'Heroine Archetype', FALSE, FALSE, 18),
  ('rep_sexual_orientation', 'Representation: Sexual Orientation', FALSE, FALSE, 119),
  ('rep_gender_identity', 'Representation: Gender Identity', FALSE, FALSE, 120),
  ('rep_relationship_structure', 'Representation: Relationship Structure', FALSE, FALSE, 121),
  ('rep_physical_disability', 'Representation: Physical Disability', FALSE, FALSE, 122),
  ('rep_chronic_illness', 'Representation: Chronic Illness', FALSE, FALSE, 123),
  ('rep_neurodivergence', 'Representation: Neurodivergence', FALSE, FALSE, 124),
  ('rep_mental_health', 'Representation: Mental Health', FALSE, FALSE, 125),
  ('rep_body_age', 'Representation: Body / Age', FALSE, FALSE, 126),
  ('rep_race_culture', 'Representation: Race / Culture', FALSE, FALSE, 127),
  ('rep_religion', 'Representation: Religion', FALSE, FALSE, 128),
  ('rep_background', 'Representation: Background', FALSE, FALSE, 129),
  ('content_warning', 'Hard Nos: Content Warnings', FALSE, TRUE, 200),
  ('kink_bundle', 'Kink Bundles', FALSE, TRUE, 210),
  ('kink_detail', 'Kink Details', FALSE, TRUE, 211);

CREATE TEMP TABLE _seed_tags (
  category TEXT,
  name TEXT,
  slug TEXT,
  description TEXT,
  parent_tag_id UUID,
  sensitive_flag BOOLEAN,
  is_premium BOOLEAN,
  display_order INT,
  metadata JSONB,
  parent_slug TEXT
) ON COMMIT DROP;

INSERT INTO _seed_tags (category, name, slug, description, parent_tag_id, sensitive_flag, is_premium, display_order, metadata, parent_slug)
VALUES
  ('world_framework', 'Contemporary', 'contemporary', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('world_framework', 'Historical', 'historical', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('world_framework', 'Paranormal', 'paranormal', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('world_framework', 'Fantasy', 'fantasy', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('world_framework', 'Sci-Fi', 'sci_fi', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('pairing', 'M/F', 'mf', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('pairing', 'M/M', 'mm', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('pairing', 'F/F', 'ff', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('pairing', 'Reverse Harem', 'reverse_harem', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('pairing', 'Harem', 'harem', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('pairing', 'Polyamory', 'polyamory', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('pairing', 'MMF (MM present)', 'mmf', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('pairing', 'MFM (no MM)', 'mfm', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('pairing', 'FFM (FF present)', 'ffm', NULL, NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('pairing', 'FMF (no FF)', 'fmf', NULL, NULL, FALSE, FALSE, 10, '{}'::jsonb, NULL),
  ('heat_level', 'HL_1 — Clean/Sweet', 'hl_1', 'No on-page sex.', NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('heat_level', 'HL_2 — Warm', 'hl_2', 'Fade-to-black / minimal description.', NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('heat_level', 'HL_3 — Steamy', 'hl_3', 'On-page sex, moderate detail (often 2–4 scenes).', NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('heat_level', 'HL_4 — Hot', 'hl_4', 'Explicit, detailed sex scenes (often 4–6+).', NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('heat_level', 'HL_5 — Scorching', 'hl_5', 'Very frequent/explicit, erotica-adjacent.', NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('series_status', 'Standalone', 'standalone', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('series_status', 'Series (Standalone Entry)', 'series_standalone', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('series_status', 'Series — Book 1', 'series_book_1', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('series_status', 'Series — Middle', 'series_middle', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('series_status', 'Series — Finale', 'series_finale', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('series_status', 'Duet — Part 1', 'duet_part_1', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('series_status', 'Duet — Part 2', 'duet_part_2', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('series_status', 'Cliffhanger', 'cliffhanger', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('consent_mode', 'Contextual', 'contextual', 'Mutual desire clear; explicit negotiation not shown.', NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('consent_mode', 'Clear/Explicit', 'clear_explicit', 'Affirmative consent shown on-page.', NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('consent_mode', 'Negotiated', 'negotiated', 'BDSM/power exchange with explicit negotiation, safewords, limits, often aftercare.', NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('consent_mode', 'Dubious', 'dubious', 'Consent murky due to coercion/intoxication/power imbalance/etc.', NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('consent_mode', 'CNC', 'cnc', 'Consensual non-consent (pre-negotiated).', NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('tone', 'Rom-Com / Humor-Forward', 'rom_com_humor', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('tone', 'Dark Tone', 'dark_tone', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('tone', 'Cozy / Comfort Read', 'cozy_comfort_read', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('tone', 'Angsty / High Emotional Turmoil', 'angsty_emotional', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('tone', 'Melancholic / Lyrical', 'melancholic_lyrical', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('tone', 'Whimsical', 'whimsical', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('tone', 'Gritty / Realist', 'gritty_realist', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('tone', 'High Drama / Soap Energy', 'high_drama_soap', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('plot_engine', 'Suspense / Investigation', 'suspense_investigation', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('plot_engine', 'Mystery / Whodunit', 'mystery_whodunit', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('plot_engine', 'Action / Survival', 'action_survival', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('plot_engine', 'War / Combat', 'war_combat', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('plot_engine', 'Political / Court Intrigue', 'political_intrigue', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('plot_engine', 'Quest / Journey', 'quest_journey', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('plot_engine', 'Heist / Crime', 'heist_crime', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('plot_engine', 'Sports Season', 'sports_season', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('plot_engine', 'Competition / Rivalry', 'competition_rivalry', NULL, NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('plot_engine', 'Workplace / Career Stakes', 'workplace_career', NULL, NULL, FALSE, FALSE, 10, '{}'::jsonb, NULL),
  ('plot_engine', 'Family Saga', 'family_saga', NULL, NULL, FALSE, FALSE, 11, '{}'::jsonb, NULL),
  ('plot_engine', 'Medical / Hospital Stakes', 'medical_hospital', NULL, NULL, FALSE, FALSE, 12, '{}'::jsonb, NULL),
  ('setting_wrapper', 'Western Setting', 'western_setting', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('setting_wrapper', 'Small Town', 'small_town', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('setting_wrapper', 'Big City', 'big_city', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('setting_wrapper', 'Rural / Ranch / Farm', 'rural_ranch_farm', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('setting_wrapper', 'Academia', 'academia', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('setting_wrapper', 'Celebrity / Fame', 'celebrity_fame', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('setting_wrapper', 'Military Base', 'military_base', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('setting_wrapper', 'Royal Court', 'royal_court', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('seasonal_wrapper', 'Christmas', 'christmas', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('seasonal_wrapper', 'Halloween', 'halloween', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('seasonal_wrapper', 'Valentine''s Day', 'valentines_day', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('seasonal_wrapper', 'Summer', 'summer', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('seasonal_wrapper', 'Fall/Autumn', 'fall_autumn', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('seasonal_wrapper', 'Holiday / Seasonal', 'holiday_seasonal', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('aesthetic_atmosphere', 'Gothic / Haunted Atmosphere', 'gothic_haunted', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('aesthetic_atmosphere', 'Dark Academia', 'dark_academia', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('aesthetic_atmosphere', 'Fairy-tale', 'fairy_tale', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('aesthetic_atmosphere', 'Southern Gothic', 'southern_gothic', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('aesthetic_atmosphere', 'Regency Drawing Room', 'regency_drawing_room', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('aesthetic_atmosphere', 'Cottagecore', 'cottagecore', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('aesthetic_atmosphere', 'Coastal', 'coastal', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('aesthetic_atmosphere', 'Gilded Age', 'gilded_age', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('market_life_stage', 'New Adult (18–25)', 'new_adult', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('market_life_stage', 'Midlife (35–50)', 'midlife', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('market_life_stage', 'Later-in-Life (50+)', 'later_in_life', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('trope', 'Enemies to Lovers', 'enemies_to_lovers', 'Characters start as adversaries', NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('trope', 'Friends to Lovers', 'friends_to_lovers', 'Friendship evolves into romance', NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('trope', 'Fake Dating', 'fake_dating', 'Pretend relationship becomes real', NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('trope', 'Marriage of Convenience', 'marriage_of_convenience', 'Practical union develops into love', NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('trope', 'Forced Proximity', 'forced_proximity', 'Characters forced into close quarters', NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('trope', 'Opposites Attract', 'opposites_attract', 'Different personalities drawn together', NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('trope', 'Grumpy/Sunshine', 'grumpy_sunshine', 'Pessimist meets optimist', NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('trope', 'Forbidden Romance', 'forbidden_romance', 'Love against social rules', NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('trope', 'Love Triangle', 'love_triangle', 'Three-way romantic tension', NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('trope', 'Second Chance Romance', 'second_chance', 'Rekindled past love', NULL, FALSE, FALSE, 10, '{}'::jsonb, NULL),
  ('trope', 'Bodyguard Romance', 'bodyguard_romance', 'Protector falls for protected', NULL, FALSE, FALSE, 11, '{}'::jsonb, NULL),
  ('trope', 'Boss/Employee', 'boss_employee', 'Workplace power dynamic romance', NULL, FALSE, FALSE, 12, '{}'::jsonb, NULL),
  ('trope', 'Teacher/Student (Aged Up)', 'teacher_student_aged', 'Academic power dynamic, adult characters', NULL, FALSE, FALSE, 13, '{}'::jsonb, NULL),
  ('trope', 'Age Gap Romance', 'age_gap', 'Significant age difference', NULL, FALSE, FALSE, 14, '{}'::jsonb, NULL),
  ('trope', 'Bully Romance', 'bully_romance', 'Tormentor becomes lover', NULL, FALSE, FALSE, 15, '{}'::jsonb, NULL),
  ('trope', 'Possessive / Obsessive Love Interest', 'possessive_obsessive', 'Intense, consuming attachment', NULL, FALSE, FALSE, 16, '{}'::jsonb, NULL),
  ('trope', 'Touch Starvation', 'touch_starvation', 'Craving physical connection', NULL, FALSE, FALSE, 17, '{}'::jsonb, NULL),
  ('trope', 'Slow Burn', 'slow_burn', 'Gradual romantic development', NULL, FALSE, FALSE, 18, '{}'::jsonb, NULL),
  ('trope', 'Instalove / Fast Burn', 'instalove_fast_burn', 'Quick romantic connection', NULL, FALSE, FALSE, 19, '{}'::jsonb, NULL),
  ('trope', 'Only One Bed', 'only_one_bed', 'Forced bed sharing', NULL, FALSE, FALSE, 20, '{}'::jsonb, NULL),
  ('trope', 'Found Family', 'found_family', 'Chosen family bonds', NULL, FALSE, FALSE, 21, '{}'::jsonb, NULL),
  ('trope', 'Hurt/Comfort', 'hurt_comfort', 'Healing through care', NULL, FALSE, FALSE, 22, '{}'::jsonb, NULL),
  ('trope', 'Caretaking', 'caretaking', 'One character caring for another', NULL, FALSE, FALSE, 23, '{}'::jsonb, NULL),
  ('trope', 'Pining / Unrequited (Initially)', 'pining_unrequited', 'One-sided longing', NULL, FALSE, FALSE, 24, '{}'::jsonb, NULL),
  ('trope', 'Single Parent', 'single_parent', 'Character raising child alone', NULL, FALSE, FALSE, 25, '{}'::jsonb, NULL),
  ('trope', 'Small Town Return', 'small_town_return', 'Coming back home', NULL, FALSE, FALSE, 26, '{}'::jsonb, NULL),
  ('trope', 'Fish Out of Water', 'fish_out_of_water', 'Character in unfamiliar setting', NULL, FALSE, FALSE, 27, '{}'::jsonb, NULL),
  ('trope', 'Celebrity/Commoner', 'celebrity_commoner', 'Fame meets ordinary life', NULL, FALSE, FALSE, 28, '{}'::jsonb, NULL),
  ('trope', 'Workplace Romance', 'workplace_romance', 'Office romance', NULL, FALSE, FALSE, 29, '{}'::jsonb, NULL),
  ('trope', 'Sex-Forward Narrative', 'sex_forward', 'Sex drives character/plot change', NULL, FALSE, FALSE, 30, '{}'::jsonb, NULL),
  ('trope', 'Virgin MC', 'virgin_mc', 'Sexually inexperienced main character', NULL, FALSE, FALSE, 31, '{}'::jsonb, NULL),
  ('trope', 'Secret Relationship', 'secret_relationship', 'Hidden romance', NULL, FALSE, FALSE, 32, '{}'::jsonb, NULL),
  ('trope', 'Secret Baby', 'secret_baby', 'Hidden pregnancy/child', NULL, FALSE, FALSE, 33, '{}'::jsonb, NULL),
  ('trope', 'Epilogue Babies', 'epilogue_babies', 'Children in epilogue', NULL, FALSE, FALSE, 34, '{}'::jsonb, NULL),
  ('hero_archetype', 'Alpha', 'alpha', 'Dominant, commanding, protective', NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('hero_archetype', 'Beta', 'beta', 'Supportive, communicative, emotionally available', NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('hero_archetype', 'Cinnamon Roll', 'cinnamon_roll', 'Pure, sweet, soft', NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('hero_archetype', 'Alphahole', 'alphahole', 'Alpha pushed to jerk territory', NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('hero_archetype', 'Grumpy', 'grumpy_hero', 'Stoic, irritable exterior, soft center', NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('hero_archetype', 'Golden Retriever', 'golden_retriever', 'Enthusiastic, loyal, sunny', NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('hero_archetype', 'Morally Grey', 'morally_grey_hero', 'Ethically ambiguous', NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('hero_archetype', 'Tortured', 'tortured', 'Traumatic past defines him', NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('hero_archetype', 'Brooding', 'brooding', 'Dark, mysterious, few words', NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('hero_archetype', 'Silver Fox', 'silver_fox', 'Older, distinguished, experienced', NULL, FALSE, FALSE, 10, '{}'::jsonb, NULL),
  ('hero_archetype', 'Nerd/Geek', 'nerd_geek', 'Intellectual, possibly awkward', NULL, FALSE, FALSE, 11, '{}'::jsonb, NULL),
  ('hero_archetype', 'Rake/Playboy', 'rake_playboy', 'Reputation for promiscuity', NULL, FALSE, FALSE, 12, '{}'::jsonb, NULL),
  ('hero_archetype', 'Himbo', 'himbo', 'Hot, uncomplicated, kind', NULL, FALSE, FALSE, 13, '{}'::jsonb, NULL),
  ('hero_archetype', 'Villain', 'villain_hero', 'Actual antagonist as love interest', NULL, FALSE, FALSE, 14, '{}'::jsonb, NULL),
  ('hero_archetype', 'Beast', 'beast', 'Monstrous in appearance or reputation', NULL, FALSE, FALSE, 15, '{}'::jsonb, NULL),
  ('hero_archetype', 'Protector', 'protector', 'Bodyguard, soldier, security', NULL, FALSE, FALSE, 16, '{}'::jsonb, NULL),
  ('hero_archetype', 'Crime Boss', 'crime_boss', 'Mafia don, cartel leader', NULL, FALSE, FALSE, 17, '{}'::jsonb, NULL),
  ('hero_archetype', 'Royalty', 'royalty_hero', 'Prince, king, duke', NULL, FALSE, FALSE, 18, '{}'::jsonb, NULL),
  ('hero_archetype', 'Cowboy', 'cowboy', 'Rugged, self-sufficient', NULL, FALSE, FALSE, 19, '{}'::jsonb, NULL),
  ('hero_archetype', 'Lone Wolf', 'lone_wolf', 'Solitary by choice', NULL, FALSE, FALSE, 20, '{}'::jsonb, NULL),
  ('hero_archetype', 'Professor', 'professor', 'Academic authority', NULL, FALSE, FALSE, 21, '{}'::jsonb, NULL),
  ('hero_archetype', 'Doctor/Healer', 'doctor_healer', 'Medical professional', NULL, FALSE, FALSE, 22, '{}'::jsonb, NULL),
  ('hero_archetype', 'Artist/Creative', 'artist_creative_hero', 'Musician, painter, writer', NULL, FALSE, FALSE, 23, '{}'::jsonb, NULL),
  ('hero_archetype', 'Soldier/Veteran', 'soldier_veteran', 'Military background', NULL, FALSE, FALSE, 24, '{}'::jsonb, NULL),
  ('hero_archetype', 'Soft Dom', 'soft_dom', 'Dominant in bedroom, worshipful', NULL, FALSE, FALSE, 25, '{}'::jsonb, NULL),
  ('hero_archetype', 'Sadist', 'sadist_hero', 'Enjoys inflicting consensual pain', NULL, FALSE, FALSE, 26, '{}'::jsonb, NULL),
  ('hero_archetype', 'Daddy Dom', 'daddy_dom', 'Caregiver dominance', NULL, FALSE, FALSE, 27, '{}'::jsonb, NULL),
  ('hero_archetype', 'Switch', 'switch_hero', 'Flows between dominant and submissive', NULL, FALSE, FALSE, 28, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Strong/Independent', 'strong_independent', 'Self-sufficient, capable', NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Sunshine', 'sunshine', 'Optimistic, warm', NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Ice Queen', 'ice_queen', 'Cold exterior, controlled', NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Wallflower', 'wallflower', 'Shy, overlooked', NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Spitfire', 'spitfire', 'Feisty, quick-tempered', NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Kick-Ass', 'kick_ass', 'Physically capable', NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Brainy/Nerdy', 'brainy_nerdy', 'Intelligence-forward', NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Boss Babe', 'boss_babe', 'Career-focused, ambitious', NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Curvy', 'curvy', 'Plus-size heroine celebrated', NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Innocent/Virgin', 'innocent_virgin', 'Sexually inexperienced', NULL, FALSE, FALSE, 10, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Older Woman', 'older_woman', '35+, knows herself', NULL, FALSE, FALSE, 11, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Single Mom', 'single_mom', 'Package deal', NULL, FALSE, FALSE, 12, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Widow/Grieving', 'widow_grieving', 'Lost previous partner', NULL, FALSE, FALSE, 13, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Struggling/Broke', 'struggling_broke', 'Financial hardship', NULL, FALSE, FALSE, 14, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Brat', 'brat', 'Pushes buttons, playful defiance', NULL, FALSE, FALSE, 15, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Submissive', 'submissive', 'Finds freedom in surrender', NULL, FALSE, FALSE, 16, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Caregiver', 'caregiver', 'Nurturing, puts others first', NULL, FALSE, FALSE, 17, '{}'::jsonb, NULL),
  ('heroine_archetype', 'Bad Girl', 'bad_girl', 'Morally grey, possibly criminal', NULL, FALSE, FALSE, 18, '{}'::jsonb, NULL),
  ('rep_sexual_orientation', 'Gay MC', 'gay_mc', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_sexual_orientation', 'Lesbian MC', 'lesbian_mc', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_sexual_orientation', 'Bisexual MC', 'bisexual_mc', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('rep_sexual_orientation', 'Pansexual MC', 'pansexual_mc', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('rep_sexual_orientation', 'Asexual MC', 'asexual_mc', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('rep_sexual_orientation', 'Demisexual MC', 'demisexual_mc', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('rep_sexual_orientation', 'Aromantic MC', 'aromantic_mc', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('rep_sexual_orientation', 'Queer MC (Umbrella)', 'queer_mc', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('rep_sexual_orientation', 'Fluid Sexuality', 'fluid_sexuality', NULL, NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('rep_gender_identity', 'Trans MC', 'trans_mc', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_gender_identity', 'Trans Man MC', 'trans_man_mc', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_gender_identity', 'Trans Woman MC', 'trans_woman_mc', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('rep_gender_identity', 'Non-Binary MC', 'non_binary_mc', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('rep_gender_identity', 'Genderfluid MC', 'genderfluid_mc', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('rep_gender_identity', 'Genderqueer MC', 'genderqueer_mc', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('rep_gender_identity', 'Agender MC', 'agender_mc', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('rep_gender_identity', 'Two-Spirit MC', 'two_spirit_mc', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('rep_gender_identity', 'Intersex MC', 'intersex_mc', NULL, NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('rep_relationship_structure', 'Polyamorous Rep', 'polyamorous_rep', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_relationship_structure', 'Open Relationship', 'open_relationship', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_relationship_structure', 'Queerplatonic Rep', 'queerplatonic_rep', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('rep_physical_disability', 'Mobility Disability', 'mobility_disability', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_physical_disability', 'Amputee MC', 'amputee_mc', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_physical_disability', 'Blind/Low Vision MC', 'blind_low_vision_mc', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('rep_physical_disability', 'Deaf/Hard of Hearing MC', 'deaf_hoh_mc', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('rep_physical_disability', 'Little Person MC', 'little_person_mc', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('rep_physical_disability', 'Speech Disability', 'speech_disability', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Chronic Illness', 'chronic_illness', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Chronic Pain', 'chronic_pain', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'EDS/Hypermobility', 'eds_hypermobility', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Chronic Fatigue/ME', 'chronic_fatigue_me', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'POTS/Dysautonomia', 'pots_dysautonomia', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Endometriosis', 'endometriosis', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Diabetes', 'diabetes', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Epilepsy', 'epilepsy', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Autoimmune Condition', 'autoimmune', NULL, NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Cancer Survivor/Patient', 'cancer', NULL, NULL, FALSE, FALSE, 10, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Heart Condition', 'heart_condition', NULL, NULL, FALSE, FALSE, 11, '{}'::jsonb, NULL),
  ('rep_chronic_illness', 'Service Animal', 'service_animal', NULL, NULL, FALSE, FALSE, 12, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Autistic MC', 'autistic_mc', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Late-Diagnosed Autistic', 'late_diagnosed_autistic', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'AuDHD', 'audhd', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL);

INSERT INTO _seed_tags (category, name, slug, description, parent_tag_id, sensitive_flag, is_premium, display_order, metadata, parent_slug)
VALUES
  ('rep_neurodivergence', 'High Support Needs', 'high_support_needs', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Autistic Masking', 'autistic_masking', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'ADHD MC', 'adhd_mc', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'ADHD Inattentive', 'adhd_inattentive', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'ADHD Hyperactive', 'adhd_hyperactive', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'ADHD Combined', 'adhd_combined', NULL, NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'RSD Depicted', 'rsd_depicted', NULL, NULL, FALSE, FALSE, 10, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Dyslexia', 'dyslexia', NULL, NULL, FALSE, FALSE, 11, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Dyscalculia', 'dyscalculia', NULL, NULL, FALSE, FALSE, 12, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Dysgraphia', 'dysgraphia', NULL, NULL, FALSE, FALSE, 13, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Dyspraxia', 'dyspraxia', NULL, NULL, FALSE, FALSE, 14, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Auditory Processing', 'auditory_processing', NULL, NULL, FALSE, FALSE, 15, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'OCD', 'ocd', NULL, NULL, FALSE, FALSE, 16, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Tourette''s', 'tourettes', NULL, NULL, FALSE, FALSE, 17, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Selective Mutism', 'selective_mutism', NULL, NULL, FALSE, FALSE, 18, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Non-Speaking/AAC User', 'non_speaking_aac', NULL, NULL, FALSE, FALSE, 19, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Sensory Processing', 'sensory_processing', NULL, NULL, FALSE, FALSE, 20, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Highly Sensitive (HSP)', 'highly_sensitive', NULL, NULL, FALSE, FALSE, 21, '{}'::jsonb, NULL),
  ('rep_neurodivergence', 'Gifted/Twice-Exceptional', 'gifted_twice_exceptional', NULL, NULL, FALSE, FALSE, 22, '{}'::jsonb, NULL),
  ('rep_mental_health', 'Anxiety Disorder', 'anxiety_disorder', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_mental_health', 'Depression', 'depression', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_mental_health', 'Panic Disorder', 'panic_disorder', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('rep_mental_health', 'Social Anxiety', 'social_anxiety', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('rep_mental_health', 'Eating Disorder', 'eating_disorder', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('rep_mental_health', 'In Recovery', 'in_recovery', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('rep_mental_health', 'Therapy on Page', 'therapy_on_page', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('rep_mental_health', 'Agoraphobia', 'agoraphobia', NULL, NULL, FALSE, FALSE, 8, '{}'::jsonb, NULL),
  ('rep_mental_health', 'Grief/Mourning', 'grief_mourning', NULL, NULL, FALSE, FALSE, 9, '{}'::jsonb, NULL),
  ('rep_mental_health', 'BPD', 'bpd', NULL, NULL, FALSE, FALSE, 10, '{}'::jsonb, NULL),
  ('rep_mental_health', 'Bipolar', 'bipolar', NULL, NULL, FALSE, FALSE, 11, '{}'::jsonb, NULL),
  ('rep_mental_health', 'C-PTSD', 'c_ptsd', NULL, NULL, FALSE, FALSE, 12, '{}'::jsonb, NULL),
  ('rep_mental_health', 'PTSD', 'ptsd', NULL, NULL, FALSE, FALSE, 13, '{}'::jsonb, NULL),
  ('rep_body_age', 'Fat Positive', 'fat_positive', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_body_age', 'Body Positive', 'body_positive', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_race_culture', 'BIPOC MC', 'bipoc_mc', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_race_culture', 'Black MC', 'black_mc', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_race_culture', 'Indigenous MC', 'indigenous_mc', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('rep_race_culture', 'Latine/Hispanic MC', 'latine_hispanic_mc', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('rep_race_culture', 'Asian MC', 'asian_mc', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('rep_race_culture', 'MENA MC', 'mena_mc', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('rep_race_culture', 'Mixed Race MC', 'mixed_race_mc', NULL, NULL, FALSE, FALSE, 7, '{}'::jsonb, NULL),
  ('rep_religion', 'Jewish MC', 'jewish_mc', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_religion', 'Muslim MC', 'muslim_mc', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_religion', 'Religious/Faith MC', 'religious_faith_mc', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('rep_background', 'Immigrant MC', 'immigrant_mc', NULL, NULL, FALSE, FALSE, 1, '{}'::jsonb, NULL),
  ('rep_background', 'Refugee MC', 'refugee_mc', NULL, NULL, FALSE, FALSE, 2, '{}'::jsonb, NULL),
  ('rep_background', 'Sex Worker MC', 'sex_worker_mc', NULL, NULL, FALSE, FALSE, 3, '{}'::jsonb, NULL),
  ('rep_background', 'Formerly Incarcerated', 'formerly_incarcerated', NULL, NULL, FALSE, FALSE, 4, '{}'::jsonb, NULL),
  ('rep_background', 'HIV+', 'hiv_positive', NULL, NULL, FALSE, FALSE, 5, '{}'::jsonb, NULL),
  ('rep_background', 'Own Voices', 'own_voices', NULL, NULL, FALSE, FALSE, 6, '{}'::jsonb, NULL),
  ('content_warning', 'Sexual Assault', 'sexual_assault', NULL, NULL, TRUE, FALSE, 1, '{}'::jsonb, NULL),
  ('content_warning', 'Non-Consent', 'non_consent', NULL, NULL, TRUE, FALSE, 2, '{}'::jsonb, NULL),
  ('content_warning', 'Dubious Consent', 'dubious_consent', NULL, NULL, TRUE, FALSE, 3, '{}'::jsonb, NULL),
  ('content_warning', 'Abuse Depicted', 'abuse_depicted', NULL, NULL, TRUE, FALSE, 4, '{}'::jsonb, NULL),
  ('content_warning', 'Domestic Violence', 'domestic_violence', NULL, NULL, TRUE, FALSE, 5, '{}'::jsonb, NULL),
  ('content_warning', 'Child Abuse (Backstory)', 'child_abuse_backstory', NULL, NULL, TRUE, FALSE, 6, '{}'::jsonb, NULL),
  ('content_warning', 'Cheating', 'cheating', NULL, NULL, TRUE, FALSE, 7, '{}'::jsonb, NULL),
  ('content_warning', 'Other Woman/Man Drama', 'other_woman_man_drama', NULL, NULL, TRUE, FALSE, 8, '{}'::jsonb, NULL),
  ('content_warning', 'Death on Page', 'death_on_page', NULL, NULL, TRUE, FALSE, 9, '{}'::jsonb, NULL),
  ('content_warning', 'Graphic Violence', 'graphic_violence', NULL, NULL, TRUE, FALSE, 10, '{}'::jsonb, NULL),
  ('content_warning', 'Gore', 'gore', NULL, NULL, TRUE, FALSE, 11, '{}'::jsonb, NULL),
  ('content_warning', 'Murder', 'murder', NULL, NULL, TRUE, FALSE, 12, '{}'::jsonb, NULL),
  ('content_warning', 'Love Interest Death', 'love_interest_death', NULL, NULL, TRUE, FALSE, 13, '{}'::jsonb, NULL),
  ('content_warning', 'Self-Harm', 'self_harm', NULL, NULL, TRUE, FALSE, 14, '{}'::jsonb, NULL),
  ('content_warning', 'Suicide', 'suicide', NULL, NULL, TRUE, FALSE, 15, '{}'::jsonb, NULL),
  ('content_warning', 'Addiction', 'addiction', NULL, NULL, TRUE, FALSE, 16, '{}'::jsonb, NULL),
  ('content_warning', 'Overdose', 'overdose', NULL, NULL, TRUE, FALSE, 17, '{}'::jsonb, NULL),
  ('content_warning', 'Incest', 'incest', NULL, NULL, TRUE, FALSE, 18, '{}'::jsonb, NULL),
  ('content_warning', 'Pregnancy Loss', 'pregnancy_loss', NULL, NULL, TRUE, FALSE, 19, '{}'::jsonb, NULL),
  ('content_warning', 'Pregnancy', 'pregnancy', NULL, NULL, TRUE, FALSE, 20, '{}'::jsonb, NULL),
  ('content_warning', 'Infertility', 'infertility', NULL, NULL, TRUE, FALSE, 21, '{}'::jsonb, NULL),
  ('content_warning', 'Kidnapping', 'kidnapping', NULL, NULL, TRUE, FALSE, 22, '{}'::jsonb, NULL),
  ('content_warning', 'Captivity', 'captivity', NULL, NULL, TRUE, FALSE, 23, '{}'::jsonb, NULL),
  ('content_warning', 'Stalking', 'stalking', NULL, NULL, TRUE, FALSE, 24, '{}'::jsonb, NULL),
  ('content_warning', 'Significant Age Gap', 'significant_age_gap', NULL, NULL, TRUE, FALSE, 25, '{}'::jsonb, NULL),
  ('content_warning', 'Power Imbalance', 'power_imbalance', NULL, NULL, TRUE, FALSE, 26, '{}'::jsonb, NULL),
  ('content_warning', 'HFN (Not HEA)', 'hfn_not_hea', NULL, NULL, TRUE, FALSE, 27, '{}'::jsonb, NULL),
  ('content_warning', 'Animal Harm', 'animal_harm', NULL, NULL, TRUE, FALSE, 28, '{}'::jsonb, NULL),
  ('content_warning', 'Child in Danger', 'child_in_danger', NULL, NULL, TRUE, FALSE, 29, '{}'::jsonb, NULL),
  ('content_warning', 'Child Death', 'child_death', NULL, NULL, TRUE, FALSE, 30, '{}'::jsonb, NULL),
  ('content_warning', 'Medical Trauma', 'medical_trauma', NULL, NULL, TRUE, FALSE, 31, '{}'::jsonb, NULL),
  ('content_warning', 'Terminal Illness', 'terminal_illness', NULL, NULL, TRUE, FALSE, 32, '{}'::jsonb, NULL),
  ('content_warning', 'War/Combat', 'war_combat_cw', NULL, NULL, TRUE, FALSE, 33, '{}'::jsonb, NULL),
  ('content_warning', 'Torture', 'torture', NULL, NULL, TRUE, FALSE, 34, '{}'::jsonb, NULL),
  ('content_warning', 'Racism Depicted', 'racism_depicted', NULL, NULL, TRUE, FALSE, 35, '{}'::jsonb, NULL),
  ('content_warning', 'Homophobia Depicted', 'homophobia_depicted', NULL, NULL, TRUE, FALSE, 36, '{}'::jsonb, NULL),
  ('content_warning', 'Transphobia Depicted', 'transphobia_depicted', NULL, NULL, TRUE, FALSE, 37, '{}'::jsonb, NULL),
  ('kink_bundle', 'Power & Control', 'power_control', 'Dominance, submission, control dynamics', NULL, TRUE, TRUE, 1, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'BDSM Structures', 'bdsm_structures', 'Formal BDSM frameworks and protocols', NULL, TRUE, TRUE, 2, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Restraint & Confinement', 'restraint_confinement', 'Bondage and restriction', NULL, TRUE, TRUE, 3, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Impact & Pain', 'impact_pain', 'Spanking, striking, pain play', NULL, TRUE, TRUE, 4, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Breath & Edge Play', 'breath_edge', 'Breath play, edging, orgasm control', NULL, TRUE, TRUE, 5, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Humiliation & Exposure', 'humiliation_exposure', 'Degradation, exhibition, exposure', NULL, TRUE, TRUE, 6, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Taboo Fantasy', 'taboo_fantasy', 'Taboo-coded consensual scenarios', NULL, TRUE, TRUE, 7, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Group & Sharing', 'group_sharing', 'Multiple partners, sharing', NULL, TRUE, TRUE, 8, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Body & Creature-Specific', 'body_creature', 'Monster romance, shifter-specific', NULL, TRUE, TRUE, 9, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Fluids & Biology', 'fluids_biology', 'Bodily fluids, breeding, biology', NULL, TRUE, TRUE, 10, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Roleplay & Scenario', 'roleplay_scenario', 'Pretend scenarios, costumes', NULL, TRUE, TRUE, 11, '{"bundle":true}'::jsonb, NULL),
  ('kink_bundle', 'Acts & Focus', 'acts_focus', 'Specific sexual acts and focuses', NULL, TRUE, TRUE, 12, '{"bundle":true}'::jsonb, NULL),
  ('kink_detail', 'Orgasm Denial', 'orgasm_denial', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Ruined Orgasms', 'ruined_orgasms', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Chastity / Keyholding', 'chastity_keyholding', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Permission Kink', 'permission_kink', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Control of Clothing/Dress', 'control_clothing', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Service Dom / Service Top', 'service_dom', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Domestic Discipline', 'domestic_discipline', NULL, NULL, TRUE, TRUE, 7, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Ownership Rituals', 'ownership_rituals', NULL, NULL, TRUE, TRUE, 8, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Collar Symbolism', 'collar_symbolism', NULL, NULL, TRUE, TRUE, 9, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Rules & Punishment', 'rules_punishment', NULL, NULL, TRUE, TRUE, 10, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Praise Kink', 'praise_kink', NULL, NULL, TRUE, TRUE, 11, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Degradation', 'degradation', NULL, NULL, TRUE, TRUE, 12, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Name-Calling (Consensual)', 'name_calling', NULL, NULL, TRUE, TRUE, 13, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Worship/Devotion Dynamic', 'worship_devotion', NULL, NULL, TRUE, TRUE, 14, '{}'::jsonb, 'power_control'),
  ('kink_detail', 'Safeword Use Shown', 'safeword_shown', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'bdsm_structures'),
  ('kink_detail', 'Negotiation on Page', 'negotiation_on_page', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'bdsm_structures'),
  ('kink_detail', 'Contract/Agreement', 'contract_agreement', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'bdsm_structures'),
  ('kink_detail', 'Aftercare Depicted', 'aftercare_depicted', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'bdsm_structures'),
  ('kink_detail', 'Protocols', 'protocols', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'bdsm_structures'),
  ('kink_detail', '24/7 Dynamic', 'dynamic_24_7', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'bdsm_structures'),
  ('kink_detail', 'Training Arc', 'training_arc', NULL, NULL, TRUE, TRUE, 7, '{}'::jsonb, 'bdsm_structures'),
  ('kink_detail', 'Rope (Shibari Style)', 'rope_shibari', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'restraint_confinement'),
  ('kink_detail', 'Cuffs/Restraints', 'cuffs_restraints', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'restraint_confinement'),
  ('kink_detail', 'Spreader Bars', 'spreader_bars', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'restraint_confinement'),
  ('kink_detail', 'Gagging', 'gagging', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'restraint_confinement'),
  ('kink_detail', 'Blindfolds', 'blindfolds', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'restraint_confinement'),
  ('kink_detail', 'Hands-Pinned Restraint', 'hands_pinned', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'restraint_confinement'),
  ('kink_detail', 'Full Immobilization', 'full_immobilization', NULL, NULL, TRUE, TRUE, 7, '{}'::jsonb, 'restraint_confinement'),
  ('kink_detail', 'Sensory Deprivation Hood', 'sensory_deprivation_hood', NULL, NULL, TRUE, TRUE, 8, '{}'::jsonb, 'restraint_confinement'),
  ('kink_detail', 'Spanking', 'spanking', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Caning', 'caning', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Crop/Flogger', 'crop_flogger', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Paddling', 'paddling', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Wax Play', 'wax_play', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Temperature Play', 'temperature_play', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Scratching/Biting (Erotic)', 'scratching_biting', NULL, NULL, TRUE, TRUE, 7, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Marking/Bruising', 'marking_bruising', NULL, NULL, TRUE, TRUE, 8, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Pain Processing', 'pain_processing', NULL, NULL, TRUE, TRUE, 9, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Needle Play', 'needle_play', NULL, NULL, TRUE, TRUE, 10, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Fire Play', 'fire_play', NULL, NULL, TRUE, TRUE, 11, '{}'::jsonb, 'impact_pain'),
  ('kink_detail', 'Breath Play', 'breath_play', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'breath_edge'),
  ('kink_detail', 'Choking (Hand)', 'choking_hand', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'breath_edge'),
  ('kink_detail', 'Edging', 'edging', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'breath_edge'),
  ('kink_detail', 'Orgasm Control', 'orgasm_control', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'breath_edge'),
  ('kink_detail', 'Forced Orgasms', 'forced_orgasms', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'breath_edge'),
  ('kink_detail', 'Overstimulation', 'overstimulation', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'breath_edge'),
  ('kink_detail', 'Verbal Humiliation', 'verbal_humiliation', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'humiliation_exposure'),
  ('kink_detail', 'Objectification', 'objectification', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'humiliation_exposure'),
  ('kink_detail', 'Public Risk (Consensual)', 'public_risk', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'humiliation_exposure'),
  ('kink_detail', 'Voyeur-Allowed Scenes', 'voyeur_allowed', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'humiliation_exposure'),
  ('kink_detail', 'Pet Names (Degrading)', 'pet_names_degrading', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'humiliation_exposure'),
  ('kink_detail', 'Position Commands', 'position_commands', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'humiliation_exposure'),
  ('kink_detail', 'Blackmail Fantasy', 'blackmail_fantasy', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'taboo_fantasy'),
  ('kink_detail', 'Free Use', 'free_use', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'taboo_fantasy'),
  ('kink_detail', 'Somnophilia', 'somnophilia', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'taboo_fantasy'),
  ('kink_detail', 'Fear Play', 'fear_play', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'taboo_fantasy'),
  ('kink_detail', 'CNC Scenes', 'cnc_scenes', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'taboo_fantasy'),
  ('kink_detail', 'Threesome (Scene)', 'threesome_scene', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'group_sharing'),
  ('kink_detail', 'Orgy/Party Scene', 'orgy_party', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'group_sharing'),
  ('kink_detail', 'Partner Sharing (Consensual)', 'partner_sharing', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'group_sharing'),
  ('kink_detail', 'Voyeurism Only', 'voyeurism_only', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'group_sharing'),
  ('kink_detail', 'Exhibitionism', 'exhibitionism', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'group_sharing'),
  ('kink_detail', 'Cuckolding', 'cuckolding', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'group_sharing'),
  ('kink_detail', 'Hotwife', 'hotwife', NULL, NULL, TRUE, TRUE, 7, '{}'::jsonb, 'group_sharing'),
  ('kink_detail', 'Knotting', 'knotting', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Rut/Heat Cycles', 'rut_heat', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Claiming Bite', 'claiming_bite', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Scenting/Marking', 'scenting_marking', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Nesting', 'nesting', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Size Kink', 'size_kink', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Tail Play', 'tail_play', NULL, NULL, TRUE, TRUE, 7, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Tentacles', 'tentacles', NULL, NULL, TRUE, TRUE, 8, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Multiple Appendages', 'multiple_appendages', NULL, NULL, TRUE, TRUE, 9, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Monster Anatomy Focus', 'monster_anatomy', NULL, NULL, TRUE, TRUE, 10, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Oviposition', 'oviposition', NULL, NULL, TRUE, TRUE, 11, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Transformation Sex', 'transformation_sex', NULL, NULL, TRUE, TRUE, 12, '{}'::jsonb, 'body_creature'),
  ('kink_detail', 'Breeding Talk', 'breeding_talk', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'fluids_biology'),
  ('kink_detail', 'Cum Focus/Mess', 'cum_focus', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'fluids_biology'),
  ('kink_detail', 'Facials', 'facials', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'fluids_biology'),
  ('kink_detail', 'Creampie', 'creampie', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'fluids_biology'),
  ('kink_detail', 'Lactation', 'lactation', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'fluids_biology'),
  ('kink_detail', 'Watersports', 'watersports', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'fluids_biology'),
  ('kink_detail', 'Blood/Feeding (Vampire)', 'blood_feeding', NULL, NULL, TRUE, TRUE, 7, '{}'::jsonb, 'fluids_biology'),
  ('kink_detail', 'Scent/Musk Focus', 'scent_musk', NULL, NULL, TRUE, TRUE, 8, '{}'::jsonb, 'fluids_biology'),
  ('kink_detail', 'Squirting', 'squirting', NULL, NULL, TRUE, TRUE, 9, '{}'::jsonb, 'fluids_biology'),
  ('kink_detail', 'Boss/Employee Roleplay', 'boss_employee_roleplay', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Strangers Roleplay', 'strangers_roleplay', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Medical Exam Play', 'medical_exam_play', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Uniform Fetish', 'uniform_fetish', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Costume/Cosplay', 'costume_cosplay', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Age Play (Adults)', 'age_play_adults', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Teacher/Student Roleplay (Aged Up)', 'teacher_student_roleplay', NULL, NULL, TRUE, TRUE, 7, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Capture Fantasy (Roleplay)', 'capture_fantasy', NULL, NULL, TRUE, TRUE, 8, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Interrogation Roleplay', 'interrogation_roleplay', NULL, NULL, TRUE, TRUE, 9, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Knife Play (Fantasy)', 'knife_play', NULL, NULL, TRUE, TRUE, 10, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Weapon Play (Fantasy/Roleplay)', 'weapon_play', NULL, NULL, TRUE, TRUE, 11, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Hypnosis (Erotic/Roleplay)', 'hypnosis_erotic', NULL, NULL, TRUE, TRUE, 12, '{}'::jsonb, 'roleplay_scenario'),
  ('kink_detail', 'Oral Focus', 'oral_focus', NULL, NULL, TRUE, TRUE, 1, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Anal Play', 'anal_play', NULL, NULL, TRUE, TRUE, 2, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Double Penetration', 'double_penetration', NULL, NULL, TRUE, TRUE, 3, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Fisting', 'fisting', NULL, NULL, TRUE, TRUE, 4, '{}'::jsonb, 'acts_focus');

INSERT INTO _seed_tags (category, name, slug, description, parent_tag_id, sensitive_flag, is_premium, display_order, metadata, parent_slug)
VALUES
  ('kink_detail', 'Rimming', 'rimming', NULL, NULL, TRUE, TRUE, 5, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Face Sitting', 'face_sitting', NULL, NULL, TRUE, TRUE, 6, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Pegging', 'pegging', NULL, NULL, TRUE, TRUE, 7, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Toy Use', 'toy_use', NULL, NULL, TRUE, TRUE, 8, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Sounding', 'sounding', NULL, NULL, TRUE, TRUE, 9, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Hand Kink', 'hand_kink', NULL, NULL, TRUE, TRUE, 10, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Foot Fetish', 'foot_fetish', NULL, NULL, TRUE, TRUE, 11, '{}'::jsonb, 'acts_focus'),
  ('kink_detail', 'Lingerie Focus', 'lingerie_focus', NULL, NULL, TRUE, TRUE, 12, '{}'::jsonb, 'acts_focus');

-- 1) Upsert categories
INSERT INTO tag_categories (key, label, single_select, sensitive_by_default, display_order)
SELECT key, label, single_select, sensitive_by_default, display_order
FROM _seed_tag_categories
ON CONFLICT (key) DO UPDATE
SET
  label = EXCLUDED.label,
  single_select = EXCLUDED.single_select,
  sensitive_by_default = EXCLUDED.sensitive_by_default,
  display_order = EXCLUDED.display_order;

-- 2) Upsert tags with parent_tag_id = NULL (parent links applied in step 3)
INSERT INTO tags (
  category,
  name,
  slug,
  description,
  parent_tag_id,
  sensitive_flag,
  is_premium,
  display_order,
  metadata
)
SELECT
  s.category,
  s.name,
  s.slug,
  s.description,
  NULL::uuid AS parent_tag_id,
  s.sensitive_flag,
  s.is_premium,
  s.display_order,
  COALESCE(s.metadata, '{}'::jsonb) AS metadata
FROM _seed_tags s
ON CONFLICT (category, slug) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  parent_tag_id = NULL,
  sensitive_flag = EXCLUDED.sensitive_flag,
  is_premium = EXCLUDED.is_premium,
  display_order = EXCLUDED.display_order,
  metadata = EXCLUDED.metadata;

-- 3) Update kink parent links: kink_detail.parent_tag_id -> kink_bundle.id via parent_slug
UPDATE tags kd
SET parent_tag_id = kb.id
FROM _seed_tags s
JOIN tags kb
  ON kb.category = 'kink_bundle'
 AND kb.slug = s.parent_slug
WHERE kd.category = 'kink_detail'
  AND kd.slug = s.slug
  AND s.category = 'kink_detail';

-- 4) Safety checks (raise exceptions if something is off)
DO $$
DECLARE
  expected_categories INT := 28;
  expected_tags INT := 408;
  inserted_categories INT;
  inserted_tags INT;
  dup_count INT;
  orphan_kink_details INT;
BEGIN
  -- Categories present
  SELECT COUNT(*) INTO inserted_categories
  FROM tag_categories c
  JOIN _seed_tag_categories s ON s.key = c.key;

  IF inserted_categories <> expected_categories THEN
    RAISE EXCEPTION 'tag_categories seed mismatch: expected %, found %', expected_categories, inserted_categories;
  END IF;

  -- Tags present (by unique key)
  SELECT COUNT(*) INTO inserted_tags
  FROM tags t
  JOIN _seed_tags s ON s.category = t.category AND s.slug = t.slug;

  IF inserted_tags <> expected_tags THEN
    RAISE EXCEPTION 'tags seed mismatch: expected %, found %', expected_tags, inserted_tags;
  END IF;

  -- Duplicate protection (should be impossible due to UNIQUE index, but assert anyway)
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT category, slug, COUNT(*) c
    FROM tags
    GROUP BY category, slug
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count <> 0 THEN
    RAISE EXCEPTION 'duplicate tags detected in DB: % duplicate keys', dup_count;
  END IF;

  -- Kink detail parenting must be complete
  SELECT COUNT(*) INTO orphan_kink_details
  FROM tags kd
  WHERE kd.category = 'kink_detail'
    AND kd.parent_tag_id IS NULL;

  IF orphan_kink_details <> 0 THEN
    RAISE EXCEPTION 'kink_detail tags missing parent_tag_id: %', orphan_kink_details;
  END IF;
END $$;

COMMIT;