-- Add school engagement models for favorites, relationships, public news, and events.
-- This extends the school-community fundraising pivot without removing legacy donation fields.

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS mascot text,
  ADD COLUMN IF NOT EXISTS about text,
  ADD COLUMN IF NOT EXISTS featured_rank integer DEFAULT 0;

CREATE TABLE IF NOT EXISTS school_news (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  organization_id uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text NOT NULL,
  category text,
  is_public boolean DEFAULT true,
  published_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NULL REFERENCES campaigns(id) ON DELETE SET NULL,
  name text NOT NULL,
  team_name text,
  opponent text,
  location text,
  start_at timestamptz NOT NULL,
  end_at timestamptz,
  visibility text DEFAULT 'public',
  category text,
  details text,
  qr_code_value text,
  suggested_amounts_json jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS favorite_schools (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, school_id)
);

CREATE TABLE IF NOT EXISTS school_relationships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  relationship text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, school_id)
);

CREATE INDEX IF NOT EXISTS school_news_school_id_idx ON school_news (school_id, published_at DESC);
CREATE INDEX IF NOT EXISTS events_school_id_idx ON events (school_id, start_at ASC);
CREATE INDEX IF NOT EXISTS favorite_schools_school_id_idx ON favorite_schools (school_id);

UPDATE schools
SET mascot = CASE id
  WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' THEN 'Wolverines'
  WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' THEN 'Pioneers'
  WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3' THEN 'Community'
  ELSE mascot
END,
about = CASE id
  WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' THEN 'Large public university with active athletics, alumni, student organizations, and academic programs.'
  WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' THEN 'Comprehensive public high school supporting athletics, PTA initiatives, arts programs, and student clubs.'
  WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3' THEN 'District-aligned youth and community programs serving school-connected families across Washtenaw County.'
  ELSE about
END,
featured_rank = CASE id
  WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' THEN 1
  WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' THEN 2
  WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3' THEN 3
  ELSE featured_rank
END
WHERE id IN (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
);

INSERT INTO school_news (id, school_id, organization_id, title, summary, category, is_public, published_at)
VALUES
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '22222222-2222-2222-2222-222222222222', 'Michigan Robotics qualifies for regional championship', 'The team secured a regional berth and is raising support for fabrication, travel, and lodging.', 'Academic Programs', true, now() - interval '8 hours'),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '33333333-3333-3333-3333-333333333333', 'Pioneer booster campaign funds new away-game buses', 'Families and alumni are closing in on the transportation goal before fall athletics begin.', 'Booster Clubs', true, now() - interval '16 hours'),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd3', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '55555555-5555-5555-5555-555555555555', 'Arts & Music showcase expands with donor backing', 'Additional donor support opened up more student performances and instrument access this semester.', 'Arts & Music', true, now() - interval '26 hours'),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd4', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '66666666-6666-6666-6666-666666666666', 'Alumni scholarship drive reaches 70% of annual goal', 'Recent alumni gifts moved the scholarship campaign well ahead of last year\'s pace.', 'Alumni', true, now() - interval '36 hours')
ON CONFLICT (id) DO NOTHING;

INSERT INTO events (
  id,
  school_id,
  organization_id,
  campaign_id,
  name,
  team_name,
  opponent,
  location,
  start_at,
  end_at,
  visibility,
  category,
  details,
  qr_code_value,
  suggested_amounts_json,
  is_active
)
VALUES
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    'Varsity Soccer vs. Saline',
    'Pioneer Athletics',
    'Saline Hornets',
    'Pioneer Stadium',
    now() + interval '20 hours',
    now() + interval '23 hours',
    'public',
    'Athletics',
    'Support travel and equipment for the varsity soccer program. Donations can also be made at the gate.',
    'quickgive://donate?charityId=33333333-3333-3333-3333-333333333333&amount=10',
    '[5,10,25]'::jsonb,
    true
  ),
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '22222222-2222-2222-2222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
    'Robotics Send-Off Showcase',
    'Michigan Robotics Team',
    'Regional Exhibition',
    'North Campus Engineering Atrium',
    now() + interval '28 hours',
    now() + interval '31 hours',
    'public',
    'Academic Programs',
    'Public build reveal with student demos and travel-fund support station on site.',
    'quickgive://donate?charityId=22222222-2222-2222-2222-222222222222&amount=15',
    '[10,25,50]'::jsonb,
    true
  ),
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    '55555555-5555-5555-5555-555555555555',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc5',
    'Band Invitational',
    'Huron Arts & Music',
    'Regional Ensembles',
    'Huron Performing Arts Center',
    now() + interval '54 hours',
    now() + interval '57 hours',
    'public',
    'Arts & Music',
    'Evening performance featuring student ensembles and an instrument-access fund.',
    'quickgive://donate?charityId=55555555-5555-5555-5555-555555555555&amount=15',
    '[15,30,50]'::jsonb,
    true
  ),
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    '44444444-4444-4444-4444-444444444444',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
    'Family Engagement Night',
    'District PTA',
    'Community Planning Session',
    'Washtenaw Community Center',
    now() + interval '66 hours',
    now() + interval '68 hours',
    'parents',
    'PTA / K-12',
    'Parents-only planning night covering classroom grants, volunteers, and family event funding.',
    'quickgive://donate?charityId=44444444-4444-4444-4444-444444444444&amount=20',
    '[20,40,75]'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;
