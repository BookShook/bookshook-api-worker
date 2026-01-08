-- ============================================================================
-- 005_kink_tags.sql
-- BookShook Vault: Kink Bundles and Kink Details
-- Based on Taxonomy Reference v3.1
-- ============================================================================

BEGIN;

-- ============================================================================
-- KINK BUNDLES (12 total)
-- Premium category, multi-select
-- ============================================================================

INSERT INTO tags (id, slug, name, description, category, is_premium, sensitive_flag, display_order)
VALUES
  (gen_random_uuid(), 'power_control', 'Power & Control', 'Dominance, submission, and control dynamics', 'kink_bundle', TRUE, TRUE, 1),
  (gen_random_uuid(), 'bdsm_structures', 'BDSM Structures', 'Formal D/s protocols, contracts, and training', 'kink_bundle', TRUE, TRUE, 2),
  (gen_random_uuid(), 'restraint_confinement', 'Restraint & Confinement', 'Bondage, restraints, and sensory restriction', 'kink_bundle', TRUE, TRUE, 3),
  (gen_random_uuid(), 'impact_pain', 'Impact & Pain', 'Spanking, impact play, and pain processing', 'kink_bundle', TRUE, TRUE, 4),
  (gen_random_uuid(), 'breath_edge', 'Breath & Edge Play', 'Breath play, edging, and orgasm control', 'kink_bundle', TRUE, TRUE, 5),
  (gen_random_uuid(), 'humiliation_exposure', 'Humiliation & Exposure', 'Verbal humiliation, objectification, exhibition', 'kink_bundle', TRUE, TRUE, 6),
  (gen_random_uuid(), 'taboo_fantasy', 'Taboo Fantasy', 'Taboo-coded consensual scenarios', 'kink_bundle', TRUE, TRUE, 7),
  (gen_random_uuid(), 'group_sharing', 'Group & Sharing', 'Threesomes, group scenes, partner sharing', 'kink_bundle', TRUE, TRUE, 8),
  (gen_random_uuid(), 'body_creature', 'Body & Creature-Specific', 'Monster romance, shifter, and creature-specific kinks', 'kink_bundle', TRUE, TRUE, 9),
  (gen_random_uuid(), 'fluids_biology', 'Fluids & Biology', 'Breeding, fluids, biological elements', 'kink_bundle', TRUE, TRUE, 10),
  (gen_random_uuid(), 'roleplay_scenario', 'Roleplay & Scenario', 'Erotic roleplay and fantasy scenarios', 'kink_bundle', TRUE, TRUE, 11),
  (gen_random_uuid(), 'acts_focus', 'Acts & Focus', 'Specific sexual acts and body focus', 'kink_bundle', TRUE, TRUE, 12)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_premium = EXCLUDED.is_premium,
  sensitive_flag = EXCLUDED.sensitive_flag;

-- ============================================================================
-- KINK DETAILS
-- Premium category, multi-select, linked to parent bundles
-- ============================================================================

-- 1) Power & Control Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'power_control' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('orgasm_denial', 'Orgasm Denial', 'Denial as a power dynamic', 1),
  ('ruined_orgasms', 'Ruined Orgasms', 'Intentionally ruined orgasms', 2),
  ('chastity_keyholding', 'Chastity / Keyholding', 'Chastity devices and key control', 3),
  ('permission_kink', 'Permission Kink', 'Requiring permission for actions', 4),
  ('control_clothing', 'Control of Clothing/Dress', 'Controlling what partner wears', 5),
  ('service_dom', 'Service Dom / Service Top', 'Dominance through service', 6),
  ('domestic_discipline', 'Domestic Discipline', 'Discipline in domestic context', 7),
  ('ownership_rituals', 'Ownership Rituals', 'Rituals of ownership and belonging', 8),
  ('collar_symbolism', 'Collar Symbolism', 'Collaring and its significance', 9),
  ('rules_punishment', 'Rules & Punishment', 'Established rules with consequences', 10),
  ('praise_kink', 'Praise Kink', 'Arousal from praise and affirmation', 11),
  ('degradation', 'Degradation', 'Consensual degradation play', 12),
  ('name_calling', 'Name-Calling (Consensual)', 'Consensual use of degrading names', 13),
  ('worship_devotion', 'Worship/Devotion Dynamic', 'Worship and devotion as dynamic', 14)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 2) BDSM Structures Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'bdsm_structures' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('safeword_shown', 'Safeword Use Shown', 'Safeword use depicted on page', 1),
  ('negotiation_page', 'Negotiation on Page', 'Scene negotiation shown', 2),
  ('contract_agreement', 'Contract/Agreement', 'Formal BDSM contract or agreement', 3),
  ('aftercare_depicted', 'Aftercare Depicted', 'Post-scene aftercare shown', 4),
  ('protocols', 'Protocols', 'Formal D/s protocols followed', 5),
  ('twenty_four_seven', '24/7 Dynamic', 'Full-time power exchange', 6),
  ('training_arc', 'Training Arc', 'Submissive training storyline', 7)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 3) Restraint & Confinement Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'restraint_confinement' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('rope_shibari', 'Rope (Shibari Style)', 'Japanese rope bondage', 1),
  ('cuffs_restraints', 'Cuffs/Restraints', 'Handcuffs and restraint use', 2),
  ('spreader_bars', 'Spreader Bars', 'Spreader bar bondage', 3),
  ('gagging', 'Gagging', 'Use of gags', 4),
  ('blindfolds', 'Blindfolds', 'Sensory deprivation via blindfold', 5),
  ('hands_pinned', 'Hands-Pinned Restraint', 'Hands held or pinned', 6),
  ('full_immobilization', 'Full Immobilization', 'Complete immobilization', 7),
  ('sensory_hood', 'Sensory Deprivation Hood', 'Hoods for sensory deprivation', 8)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 4) Impact & Pain Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'impact_pain' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('spanking', 'Spanking', 'Hand spanking', 1),
  ('caning', 'Caning', 'Cane impact play', 2),
  ('crop_flogger', 'Crop/Flogger', 'Crop or flogger use', 3),
  ('paddling', 'Paddling', 'Paddle impact play', 4),
  ('wax_play', 'Wax Play', 'Hot wax play', 5),
  ('temperature_play', 'Temperature Play', 'Hot and cold sensation play', 6),
  ('scratching_biting', 'Scratching/Biting (Erotic)', 'Erotic scratching and biting', 7),
  ('marking_bruising', 'Marking/Bruising', 'Intentional marking', 8),
  ('pain_processing', 'Pain Processing', 'Focus on processing pain', 9),
  ('needle_play', 'Needle Play', 'Needle play (edge play)', 10),
  ('fire_play', 'Fire Play', 'Fire play (edge play)', 11)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 5) Breath & Edge Play Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'breath_edge' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('breath_play', 'Breath Play', 'Breath restriction play', 1),
  ('choking_hand', 'Choking (Hand)', 'Hand choking', 2),
  ('edging', 'Edging', 'Prolonged denial before orgasm', 3),
  ('orgasm_control', 'Orgasm Control', 'Controlling when partner orgasms', 4),
  ('forced_orgasms', 'Forced Orgasms', 'Multiple forced orgasms', 5),
  ('overstimulation', 'Overstimulation', 'Continued stimulation past orgasm', 6)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 6) Humiliation & Exposure Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'humiliation_exposure' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('verbal_humiliation', 'Verbal Humiliation', 'Consensual verbal humiliation', 1),
  ('objectification', 'Objectification', 'Being treated as object', 2),
  ('public_risk', 'Public Risk (Consensual)', 'Risk of public exposure', 3),
  ('voyeur_allowed', 'Voyeur-Allowed Scenes', 'Scenes with permitted voyeurs', 4),
  ('pet_names_degrading', 'Pet Names (Degrading)', 'Degrading pet names', 5),
  ('position_commands', 'Position Commands', 'Commands for body positions', 6)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 7) Taboo Fantasy Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'taboo_fantasy' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('blackmail_fantasy', 'Blackmail Fantasy', 'Consensual blackmail roleplay', 1),
  ('free_use', 'Free Use', 'Free use dynamic', 2),
  ('somnophilia', 'Somnophilia', 'Sleep play with prior consent', 3),
  ('fear_play', 'Fear Play', 'Consensual fear induction', 4),
  ('cnc_scenes', 'CNC Scenes', 'Consensual non-consent scenes', 5)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 8) Group & Sharing Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'group_sharing' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('threesome_scene', 'Threesome (Scene)', 'Threesome scene depicted', 1),
  ('orgy_party', 'Orgy/Party Scene', 'Group sex scene', 2),
  ('partner_sharing', 'Partner Sharing (Consensual)', 'Consensual partner sharing', 3),
  ('voyeurism_only', 'Voyeurism Only', 'Watching only', 4),
  ('exhibitionism', 'Exhibitionism', 'Being watched', 5),
  ('cuckolding', 'Cuckolding', 'Cuckolding dynamic', 6),
  ('hotwife', 'Hotwife', 'Hotwife dynamic', 7)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 9) Body & Creature-Specific Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'body_creature' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('knotting', 'Knotting', 'Knotting (shifter/monster)', 1),
  ('rut_heat', 'Rut/Heat Cycles', 'Mating cycles', 2),
  ('claiming_bite', 'Claiming Bite', 'Mate marking bite', 3),
  ('scenting_marking', 'Scenting/Marking', 'Scent marking', 4),
  ('nesting', 'Nesting', 'Nesting behavior', 5),
  ('size_kink', 'Size Kink', 'Size difference focus', 6),
  ('tail_play', 'Tail Play', 'Tail use in intimacy', 7),
  ('tentacles', 'Tentacles', 'Tentacle play', 8),
  ('multiple_appendages', 'Multiple Appendages', 'Multiple limbs/appendages', 9),
  ('monster_anatomy', 'Monster Anatomy Focus', 'Non-human anatomy', 10),
  ('oviposition', 'Oviposition', 'Egg laying/insertion', 11),
  ('transformation_sex', 'Transformation Sex', 'Sex during transformation', 12)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 10) Fluids & Biology Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'fluids_biology' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('breeding_talk', 'Breeding Talk', 'Breeding/impregnation talk', 1),
  ('cum_focus', 'Cum Focus/Mess', 'Focus on fluids', 2),
  ('facials', 'Facials', 'Facial finish', 3),
  ('creampie', 'Creampie', 'Internal finish', 4),
  ('lactation', 'Lactation', 'Lactation play', 5),
  ('watersports', 'Watersports', 'Urine play', 6),
  ('blood_feeding', 'Blood/Feeding (Vampire)', 'Vampire blood drinking', 7),
  ('scent_musk', 'Scent/Musk Focus', 'Focus on scent/musk', 8),
  ('squirting', 'Squirting', 'Female ejaculation', 9),
  ('blood_play', 'Blood Play', 'Blood play (edge play)', 10)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 11) Roleplay & Scenario Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'roleplay_scenario' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('boss_employee_rp', 'Boss/Employee Roleplay', 'Workplace power roleplay', 1),
  ('strangers_rp', 'Strangers Roleplay', 'Pretending to be strangers', 2),
  ('medical_exam', 'Medical Exam Play', 'Doctor/patient roleplay', 3),
  ('uniform_fetish', 'Uniform Fetish', 'Uniforms as arousal', 4),
  ('costume_cosplay', 'Costume/Cosplay', 'Costumes in intimacy', 5),
  ('age_play_adults', 'Age Play (Adults)', 'Adult age play dynamics', 6),
  ('teacher_student_rp', 'Teacher/Student Roleplay (Aged Up)', 'Teacher/student fantasy', 7),
  ('capture_fantasy', 'Capture Fantasy (Roleplay)', 'Capture/rescue roleplay', 8),
  ('interrogation_rp', 'Interrogation Roleplay', 'Interrogation scenario', 9),
  ('knife_play', 'Knife Play (Fantasy)', 'Knife as prop (edge play)', 10),
  ('weapon_play', 'Weapon Play (Fantasy)', 'Weapons as props', 11),
  ('hypnosis_erotic', 'Hypnosis (Erotic)', 'Erotic hypnosis play', 12)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- 12) Acts & Focus Details
INSERT INTO tags (id, slug, name, description, category, parent_tag_id, is_premium, sensitive_flag, display_order)
SELECT gen_random_uuid(), slug, name, description, 'kink_detail',
  (SELECT id FROM tags WHERE slug = 'acts_focus' AND category = 'kink_bundle'),
  TRUE, TRUE, display_order
FROM (VALUES
  ('oral_focus', 'Oral Focus', 'Extended oral scenes', 1),
  ('anal_play', 'Anal Play', 'Anal stimulation', 2),
  ('double_penetration', 'Double Penetration', 'DP scenes', 3),
  ('fisting', 'Fisting', 'Fisting scenes', 4),
  ('rimming', 'Rimming', 'Analingus', 5),
  ('face_sitting', 'Face Sitting', 'Face sitting scenes', 6),
  ('pegging', 'Pegging', 'Female-on-male strap-on', 7),
  ('toy_use', 'Toy Use', 'Sex toy incorporation', 8),
  ('sounding', 'Sounding', 'Urethral play', 9),
  ('hand_kink', 'Hand Kink', 'Focus on hands', 10),
  ('foot_fetish', 'Foot Fetish', 'Foot focus', 11),
  ('lingerie_focus', 'Lingerie Focus', 'Lingerie as focus', 12)
) AS t(slug, name, description, display_order)
ON CONFLICT ON CONSTRAINT tags_category_slug_unique DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

COMMIT;
