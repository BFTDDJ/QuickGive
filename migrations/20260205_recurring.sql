-- Recurring schedules
CREATE TABLE IF NOT EXISTS recurring_schedules (
  id uuid PRIMARY KEY,
  donor_id text NOT NULL,
  user_id uuid NULL,
  charity_id text NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('weekly','monthly')),
  amount_cents integer NOT NULL,
  currency text DEFAULT 'usd',
  start_date timestamptz NOT NULL,
  end_date timestamptz NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active','canceled','ended')),
  created_at timestamptz DEFAULT now(),
  canceled_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS recurring_schedules_donor_id_idx ON recurring_schedules (donor_id);
CREATE INDEX IF NOT EXISTS recurring_schedules_charity_id_idx ON recurring_schedules (charity_id);

-- Donor Stripe customer mapping for anonymous donors
CREATE TABLE IF NOT EXISTS donor_stripe_customers (
  donor_id text PRIMARY KEY,
  stripe_customer_id text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

-- Recurring donation idempotency by invoice_id
CREATE TABLE IF NOT EXISTS recurring_donations (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES recurring_schedules(id),
  donation_id uuid NOT NULL,
  invoice_id text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);
