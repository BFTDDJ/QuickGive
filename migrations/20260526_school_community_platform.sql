-- Pivot QuickGive toward school-community fundraising while keeping legacy
-- charity_id fields for backward compatibility during migration.

CREATE TABLE IF NOT EXISTS schools (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  city text,
  state text,
  kind text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  school_id uuid NULL REFERENCES schools(id) ON DELETE SET NULL,
  name text NOT NULL,
  category text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  goal_amount_cents integer,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS organization_id uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_id uuid NULL REFERENCES campaigns(id) ON DELETE SET NULL;

ALTER TABLE recurring_schedules
  ADD COLUMN IF NOT EXISTS organization_id uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_id uuid NULL REFERENCES campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS donations_organization_id_idx ON donations (organization_id);
CREATE INDEX IF NOT EXISTS donations_campaign_id_idx ON donations (campaign_id);
CREATE INDEX IF NOT EXISTS recurring_schedules_organization_id_idx ON recurring_schedules (organization_id);
CREATE INDEX IF NOT EXISTS recurring_schedules_campaign_id_idx ON recurring_schedules (campaign_id);
CREATE INDEX IF NOT EXISTS organizations_school_id_idx ON organizations (school_id);
CREATE INDEX IF NOT EXISTS campaigns_organization_id_idx ON campaigns (organization_id);

-- Demo schools
INSERT INTO schools (id, name, city, state, kind)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'University of Michigan', 'Ann Arbor', 'MI', 'university'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'Ann Arbor Pioneer High School', 'Ann Arbor', 'MI', 'high_school'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'Washtenaw Community Schools', 'Ann Arbor', 'MI', 'district')
ON CONFLICT (id) DO NOTHING;

-- Demo organizations
INSERT INTO organizations (id, school_id, name, category, description)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Michigan NIL Fund', 'NIL', 'Support Michigan student-athlete NIL opportunities.'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Michigan Robotics Team', 'Academic Programs', 'Fund travel, parts, and competition fees for student robotics.'),
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'Local High School Booster Club', 'Booster Clubs', 'Back local athletics, facilities, and team travel.'),
  ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'PTA Fund', 'PTA / K-12', 'Support teachers, field trips, and classroom experiences.'),
  ('55555555-5555-5555-5555-555555555555', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'Arts & Music Program', 'Arts & Music', 'Expand student access to instruments, performances, and art supplies.'),
  ('66666666-6666-6666-6666-666666666666', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Alumni Scholarship Fund', 'Alumni', 'Grow scholarship support for current and future students.')
ON CONFLICT (id) DO NOTHING;

-- Demo campaigns
INSERT INTO campaigns (id, organization_id, name, description, goal_amount_cents, is_active)
VALUES
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', '11111111-1111-1111-1111-111111111111', 'Spring NIL Giving Drive', 'Help launch the next cycle of student-athlete partnerships.', 5000000, true),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', '22222222-2222-2222-2222-222222222222', 'Regional Robotics Travel Fund', 'Cover travel, fabrication, and lodging for championship events.', 2500000, true),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3', '33333333-3333-3333-3333-333333333333', 'Booster Bus Campaign', 'Fund buses, equipment refresh, and away-game support.', 1500000, true),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc4', '44444444-4444-4444-4444-444444444444', 'Teacher Wish List Fund', 'Support classroom mini-grants and PTA family engagement.', 900000, true),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc5', '55555555-5555-5555-5555-555555555555', 'Summer Arts Intensive', 'Expand instruments, performance travel, and studio access.', 1800000, true),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc6', '66666666-6666-6666-6666-666666666666', 'First-Gen Scholarship Match', 'Match alumni gifts for first-generation student scholarships.', 3000000, true)
ON CONFLICT (id) DO NOTHING;
