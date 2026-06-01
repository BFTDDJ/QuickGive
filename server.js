require("./instrument");
require("dotenv").config();
const db = require("./db");
const { randomUUID, createHmac, timingSafeEqual } = require("crypto");
const { supabase } = require("./supabase");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const PDFDocument = require("pdfkit");
const { generateReceiptPdf } = require("./receiptPdf");
const { sendPasswordResetEmail } = require("./email");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Sentry = require("@sentry/node");
const { OAuth2Client } = require("google-auth-library");
const { createRemoteJWKSet, jwtVerify } = require("jose");

let ddTracer = null;
if (process.env.DD_TRACE_ENABLED === "true") {
  ddTracer = require("dd-trace").init({
    env: process.env.DD_ENV || "development",
    service: process.env.DD_SERVICE || "dono-backend",
    version: process.env.DD_VERSION || "unknown",
    logInjection: true
  });
}

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const appleJwks = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

const metrics = {
  startedAt: Date.now(),
  requests: 0,
  errors: 0,
  webhookFailures: 0,
  paymentFailures: 0
};

function logInfo(message, context = {}) {
  console.log(
    JSON.stringify({
      level: "info",
      message,
      ...context
    })
  );
}

function logError(message, context = {}) {
  console.error(
    JSON.stringify({
      level: "error",
      message,
      ...context
    })
  );
}

app.set("trust proxy", 1);

logInfo("SERVER STARTED", { started_at: new Date().toISOString() });
if (!process.env.JWT_SECRET_CURRENT) {
  logError("JWT_SECRET_CURRENT MISSING");
  process.exit(1);
}
if (!process.env.FRONTEND_RESET_URL_BASE) {
  logError("FRONTEND_RESET_URL_BASE MISSING");
  process.exit(1);
}
if (!process.env.RESEND_API_KEY) {
  logError("RESEND_API_KEY MISSING");
  process.exit(1);
}
if (!process.env.FROM_EMAIL) {
  logError("FROM_EMAIL MISSING");
  process.exit(1);
}
if (!process.env.GOOGLE_CLIENT_ID) {
  logError("GOOGLE_CLIENT_ID MISSING");
  process.exit(1);
}
if (!process.env.APPLE_CLIENT_ID) {
  logError("APPLE_CLIENT_ID MISSING");
  process.exit(1);
}
db.query("SELECT 1")
  .then(() => {
    logInfo("DB CONNECTION OK");
  })
  .catch((err) => {
    logError("DB CONNECTION FAILED", { error: err.message });
    process.exit(1);
  });

async function initUsersTable() {
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      email text UNIQUE,
      password_hash text,
      full_name text,
      auth_provider text DEFAULT 'password',
      google_sub text,
      stripe_customer_id text,
      created_at timestamptz DEFAULT now()
    )
    `
  );
  await db.query(
    `
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email text,
      ADD COLUMN IF NOT EXISTS password_hash text,
      ADD COLUMN IF NOT EXISTS full_name text,
      ADD COLUMN IF NOT EXISTS auth_provider text DEFAULT 'password',
      ADD COLUMN IF NOT EXISTS google_sub text,
      ADD COLUMN IF NOT EXISTS apple_sub text,
      ADD COLUMN IF NOT EXISTS stripe_customer_id text,
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()
    `
  );
  await db.query(
    `
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (email)
    `
  );
  await db.query(
    `
    UPDATE users
    SET auth_provider = 'password'
    WHERE auth_provider IS NULL
    `
  );
  await db.query(
    `
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
    ON users (google_sub)
    WHERE google_sub IS NOT NULL
    `
  );
  await db.query(
    `
    CREATE UNIQUE INDEX IF NOT EXISTS users_apple_sub_unique
    ON users (apple_sub)
    `
  );
  await db.query(
    `
    CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_unique
    ON users (stripe_customer_id)
    `
  );
}

initUsersTable().catch((err) => {
  console.error("USERS TABLE INIT FAILED:", err);
});

async function initDonationsTable() {
  await db.query(
    `
    ALTER TABLE donations
      ADD COLUMN IF NOT EXISTS charity_name text
    `
  );
  await db.query(
    `
    UPDATE donations
    SET charity_name = charity_id::text
    WHERE charity_name IS NULL
    `
  );
  await db.query(
    `
    ALTER TABLE donations
      ALTER COLUMN charity_name SET NOT NULL
    `
  );
}

initDonationsTable().catch((err) => {
  console.error("DONATIONS TABLE INIT FAILED:", err);
});

async function initRecurringSchedulesTable() {
  await db.query(
    `
    ALTER TABLE recurring_schedules
      ADD COLUMN IF NOT EXISTS charity_name text
    `
  );
  await db.query(
    `
    UPDATE recurring_schedules
    SET charity_name = charity_id::text
    WHERE charity_name IS NULL
    `
  );
  await db.query(
    `
    ALTER TABLE recurring_schedules
      ALTER COLUMN charity_name SET NOT NULL
    `
  );
}

initRecurringSchedulesTable().catch((err) => {
  console.error("RECURRING SCHEDULES TABLE INIT FAILED:", err);
});

async function initSchoolCommunitySchema() {
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS schools (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      city text,
      state text,
      kind text,
      mascot text,
      about text,
      featured_rank integer DEFAULT 0,
      created_at timestamptz DEFAULT now()
    )
    `
  );
  await db.query(
    `
    ALTER TABLE schools
      ADD COLUMN IF NOT EXISTS mascot text,
      ADD COLUMN IF NOT EXISTS about text,
      ADD COLUMN IF NOT EXISTS featured_rank integer DEFAULT 0
    `
  );
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS organizations (
      id uuid PRIMARY KEY,
      school_id uuid REFERENCES schools(id) ON DELETE SET NULL,
      name text NOT NULL,
      category text NOT NULL,
      description text,
      created_at timestamptz DEFAULT now()
    )
    `
  );
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS campaigns (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL,
      description text,
      goal_amount_cents integer,
      is_active boolean DEFAULT true,
      created_at timestamptz DEFAULT now()
    )
    `
  );
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS school_news (
      id uuid PRIMARY KEY,
      school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
      title text NOT NULL,
      summary text NOT NULL,
      category text,
      is_public boolean DEFAULT true,
      published_at timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now()
    )
    `
  );
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS events (
      id uuid PRIMARY KEY,
      school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
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
    )
    `
  );
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS favorite_schools (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, school_id)
    )
    `
  );
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS school_relationships (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      relationship text NOT NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, school_id)
    )
    `
  );
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS school_access_memberships (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      access_role text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz DEFAULT now(),
      approved_at timestamptz,
      updated_at timestamptz DEFAULT now(),
      approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      notes text,
      PRIMARY KEY (user_id, school_id, access_role)
    )
    `
  );
  await db.query(
    `
    ALTER TABLE donations
      ADD COLUMN IF NOT EXISTS organization_id uuid,
      ADD COLUMN IF NOT EXISTS campaign_id uuid
    `
  );
  await db.query(
    `
    ALTER TABLE recurring_schedules
      ADD COLUMN IF NOT EXISTS organization_id uuid,
      ADD COLUMN IF NOT EXISTS campaign_id uuid
    `
  );
  await db.query(`CREATE INDEX IF NOT EXISTS organizations_school_id_idx ON organizations (school_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS campaigns_organization_id_idx ON campaigns (organization_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS school_news_school_id_idx ON school_news (school_id, published_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS events_school_id_idx ON events (school_id, start_at ASC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS favorite_schools_school_id_idx ON favorite_schools (school_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS school_access_memberships_school_id_idx ON school_access_memberships (school_id, access_role, status)`);
}

initSchoolCommunitySchema().catch((err) => {
  console.error("SCHOOL COMMUNITY SCHEMA INIT FAILED:", err);
});

function normalizeOptionalUuid(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
    ? trimmed
    : null;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeRelationship(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return ["student", "alumni", "parent", "supporter"].includes(normalized)
    ? normalized
    : null;
}

function normalizeEventVisibility(value) {
  if (typeof value !== "string") {
    return "public";
  }
  const normalized = value.trim().toLowerCase();
  return ["public", "parents", "all"].includes(normalized)
    ? normalized
    : "public";
}

function normalizeAccessStatus(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return ["pending", "approved", "revoked"].includes(normalized)
    ? normalized
    : null;
}

function getEventQrSecret() {
  return process.env.EVENT_QR_SECRET || process.env.JWT_SECRET_CURRENT;
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signEventQrPayload(encodedPayload) {
  return createHmac("sha256", getEventQrSecret()).update(encodedPayload).digest("base64url");
}

function buildEventQrToken(event) {
  const expiresAt = new Date(
    Math.max(
      new Date(event.end_at || event.start_at).getTime(),
      Date.now()
    ) + 1000 * 60 * 60 * 24 * 30
  ).toISOString();

  const payload = {
    eventId: event.id,
    schoolId: event.school_id,
    organizationId: event.organization_id,
    campaignId: event.campaign_id || null,
    legacyCharityId: event.organization_id,
    expiresAt
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signEventQrPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyEventQrToken(token) {
  if (typeof token !== "string" || !token.includes(".")) {
    throw new Error("Invalid QR token");
  }
  const [encodedPayload, signature] = token.split(".", 2);
  const expectedSignature = signEventQrPayload(encodedPayload);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new Error("Invalid QR token signature");
  }
  const payload = JSON.parse(fromBase64Url(encodedPayload));
  if (!payload?.eventId || !payload?.organizationId || !payload?.schoolId) {
    throw new Error("Invalid QR token payload");
  }
  if (payload.expiresAt && new Date(payload.expiresAt) < new Date()) {
    throw new Error("QR token expired");
  }
  return payload;
}

function signToken(userId, email) {
  return jwt.sign({ sub: userId, email }, process.env.JWT_SECRET_CURRENT, {
    header: { kid: "current" },
    expiresIn: process.env.JWT_EXPIRES_IN || "7d"
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET_CURRENT);
  } catch (err) {
    if (process.env.JWT_SECRET_PREVIOUS) {
      return jwt.verify(token, process.env.JWT_SECRET_PREVIOUS);
    }
    throw err;
  }
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    logError("AUTH FAILURE", { reason: "missing_token", request_id: req.id });
    return res.status(401).json({ error: "Missing token" });
  }
  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (err) {
    logError("AUTH FAILURE", { reason: "invalid_token", request_id: req.id });
    return res.status(401).json({ error: "Invalid token" });
  }
}

function authOptional(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return next();
  }
  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
  } catch (err) {
    console.error("JWT VERIFY FAILED:", err);
  }
  return next();
}

function requireAccessAdmin(req, res, next) {
  const token = req.headers["x-access-admin-token"];
  if (!process.env.EVENT_ACCESS_ADMIN_TOKEN) {
    logError("ACCESS ADMIN TOKEN MISSING", { request_id: req.id });
    return res.status(503).json({ error: "Access approval unavailable" });
  }
  if (!token || token !== process.env.EVENT_ACCESS_ADMIN_TOKEN) {
    logError("ACCESS ADMIN AUTH FAILURE", {
      request_id: req.id,
      authorization_present: Boolean(token)
    });
    return res.status(401).json({ error: "Invalid admin token" });
  }
  return next();
}

function resolveDonorId(req) {
  if (req.user?.id) {
    return req.user.id;
  }
  return (
    req.headers["x-anon-user-id"] ||
    req.headers["x-donor-id"] ||
    req.query.userId ||
    req.query.donorId ||
    req.body?.user_id ||
    null
  );
}

async function getOrCreateStripeCustomerForUser({ userId, email }) {
  if (!userId || !email) {
    throw new Error("Missing authenticated user context for Stripe customer");
  }

  const { rows } = await db.query(
    `SELECT stripe_customer_id FROM users WHERE id = $1`,
    [userId]
  );
  const existing = rows[0]?.stripe_customer_id;
  if (existing) return existing;

  const customer = await stripe.customers.create({
    email,
    metadata: { user_id: userId, email }
  });

  await db.query(
    `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
    [customer.id, userId]
  );

  return customer.id;
}

async function getDefaultPaymentMethod(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  const defaultPm = customer?.invoice_settings?.default_payment_method;
  return defaultPm || null;
}

async function ensureCustomerDefaultPaymentMethod(customerId) {
  let defaultPaymentMethod = await getDefaultPaymentMethod(customerId);
  if (defaultPaymentMethod) {
    return defaultPaymentMethod;
  }

  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 10
  });

  const fallbackPaymentMethod = paymentMethods.data[0]?.id || null;
  if (!fallbackPaymentMethod) {
    return null;
  }

  await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: fallbackPaymentMethod
    }
  });

  return fallbackPaymentMethod;
}

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    }
  })
);

// Request ID + request logging
app.use((req, res, next) => {
  req.id = randomUUID();
  metrics.requests += 1;
  logInfo("REQUEST", {
    request_id: req.id,
    method: req.method,
    path: req.path,
    authorization_present: Boolean(req.headers.authorization)
  });
  res.on("finish", () => {
    if (res.statusCode >= 500) {
      metrics.errors += 1;
    }
  });
  next();
});


const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || "120", 10),
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || "60000", 10),
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || "10", 10),
  standardHeaders: true,
  legacyHeaders: false
});

const webhookLimiter = rateLimit({
  windowMs: parseInt(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS || "60000", 10),
  max: parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX || "300", 10),
  standardHeaders: true,
  legacyHeaders: false
});

app.use(globalLimiter);

app.post(
  "/stripe/webhook",
  webhookLimiter,
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("Stripe event received:", event.type);

    switch (event.type) {
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object;
        console.log("Payment succeeded:", paymentIntent.id);

        // Respond immediately to Stripe, then persist asynchronously.
        (async () => {
          try {
            const userId = paymentIntent?.metadata?.user_id || null;
            const organizationId = normalizeOptionalUuid(
              paymentIntent?.metadata?.organization_id
            );
            const campaignId = normalizeOptionalUuid(
              paymentIntent?.metadata?.campaign_id
            );
            // Legacy charity_id remains supported while the product moves to
            // organization_id/campaign_id for school-community fundraising.
            const charityId = paymentIntent?.metadata?.charity_id || null;
            const charityName = paymentIntent?.metadata?.charity_name || charityId || null;
            const amountCents = paymentIntent?.amount_received || 0;
            const currency = paymentIntent?.currency || "usd";
            const stripePaymentIntentId = paymentIntent?.id || null;

            if (!userId || !charityId || !charityName || !stripePaymentIntentId || amountCents <= 0) {
              logError("WEBHOOK DONATION SKIPPED INVALID DATA", {
                request_id: req.id,
                stripe_payment_intent_id: stripePaymentIntentId,
                user_id: userId,
                charity_id: charityId,
                charity_name: charityName,
                amount_cents: amountCents
              });
              return;
            }

            const result = await db.query(
              `
              INSERT INTO donations (
                id,
                amount_cents,
                currency,
                organization_id,
                campaign_id,
                charity_id,
                charity_name,
                user_id,
                stripe_payment_intent_id,
                created_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
              ON CONFLICT (stripe_payment_intent_id) DO NOTHING
              RETURNING id
              `,
              [
                randomUUID(),
                amountCents,
                currency,
                organizationId,
                campaignId,
                charityId,
                charityName,
                userId,
                stripePaymentIntentId
              ]
            );

            let donationId = result.rows[0]?.id || null;

            if (result.rowCount === 0) {
              logInfo("DUPLICATE WEBHOOK IGNORED", {
                request_id: req.id,
                stripe_payment_intent_id: stripePaymentIntentId
              });
              const existingDonation = await db.query(
                `
                SELECT id
                FROM donations
                WHERE stripe_payment_intent_id = $1
                LIMIT 1
                `,
                [stripePaymentIntentId]
              );
              donationId = existingDonation.rows[0]?.id || null;
            } else {
              logInfo("DONATION SAVED FROM WEBHOOK", {
                request_id: req.id,
                donation_id: donationId,
                stripe_payment_intent_id: stripePaymentIntentId
              });
            }

            if (donationId) {
              const receiptInsert = await db.query(
                `
                INSERT INTO receipts (
                  id,
                  donation_id,
                  tax_deductible,
                  created_at
                )
                VALUES ($1, $2, $3, now())
                ON CONFLICT (donation_id) DO NOTHING
                RETURNING id
                `,
                [randomUUID(), donationId, true]
              );

              if (receiptInsert.rowCount > 0) {
                logInfo("RECEIPT SAVED FROM WEBHOOK", {
                  request_id: req.id,
                  receipt_id: receiptInsert.rows[0].id,
                  donation_id: donationId
                });
              } else {
                logInfo("RECEIPT ALREADY EXISTS FOR DONATION", {
                  request_id: req.id,
                  donation_id: donationId
                });
              }
            }
          } catch (error) {
            logError("WEBHOOK DONATION PERSIST FAILED", {
              request_id: req.id,
              error: error.message,
              code: error.code || null,
              detail: error.detail || null,
              constraint: error.constraint || null
            });
          }
        })();
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object;

        (async () => {
          try {
            if (!invoice?.id || !invoice?.subscription) {
              logError("INVALID INVOICE DATA", {
                request_id: req.id,
                invoice_id: invoice?.id || null
              });
              return;
            }

            const { rows } = await db.query(
              `
              SELECT *
              FROM recurring_schedules
              WHERE stripe_subscription_id = $1
              LIMIT 1
              `,
              [invoice.subscription]
            );

            const schedule = rows[0];
            if (!schedule) {
              logInfo("INVOICE WITH NO SCHEDULE", {
                request_id: req.id,
                invoice_id: invoice.id,
                stripe_subscription_id: invoice.subscription
              });
              return;
            }

            if (
              schedule.end_date &&
              invoice.created * 1000 >= new Date(schedule.end_date).getTime()
            ) {
              logInfo("INVOICE AFTER END DATE IGNORED", {
                request_id: req.id,
                invoice_id: invoice.id,
                schedule_id: schedule.id
              });
              return;
            }

            const existingRecurring = await db.query(
              `
              SELECT donation_id
              FROM recurring_donations
              WHERE invoice_id = $1
              LIMIT 1
              `,
              [invoice.id]
            );

            if (existingRecurring.rowCount > 0) {
              logInfo("DUPLICATE RECURRING INVOICE IGNORED", {
                request_id: req.id,
                invoice_id: invoice.id
              });
              return;
            }

            const donationId = randomUUID();
            const stripePaymentIntentId = invoice.payment_intent || invoice.id;

            const donationInsert = await db.query(
              `
              INSERT INTO donations (
                id,
                amount_cents,
                currency,
                organization_id,
                campaign_id,
                charity_id,
                charity_name,
                user_id,
                stripe_payment_intent_id,
                created_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
              ON CONFLICT (stripe_payment_intent_id) DO NOTHING
              RETURNING id
              `,
              [
                donationId,
                invoice.amount_paid,
                invoice.currency || "usd",
                schedule.organization_id || null,
                schedule.campaign_id || null,
                schedule.charity_id,
                schedule.charity_name || schedule.charity_id,
                schedule.user_id,
                stripePaymentIntentId
              ]
            );

            const persistedDonationId = donationInsert.rows[0]?.id || donationId;

            await db.query(
              `
              INSERT INTO recurring_donations (
                id,
                schedule_id,
                donation_id,
                invoice_id,
                created_at
              )
              VALUES ($1, $2, $3, $4, now())
              ON CONFLICT (invoice_id) DO NOTHING
              `,
              [randomUUID(), schedule.id, persistedDonationId, invoice.id]
            );

            await db.query(
              `
              INSERT INTO receipts (
                id,
                donation_id,
                tax_deductible,
                created_at
              )
              VALUES ($1, $2, $3, now())
              ON CONFLICT (donation_id) DO NOTHING
              `,
              [randomUUID(), persistedDonationId, true]
            );

            logInfo("RECURRING INVOICE PAID", {
              request_id: req.id,
              invoice_id: invoice.id,
              schedule_id: schedule.id,
              donation_id: persistedDonationId
            });
          } catch (error) {
            logError("RECURRING INVOICE FAILED", {
              request_id: req.id,
              error: error.message
            });
          }
        })();
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        (async () => {
          try {
            if (!subscription?.id) {
              logError("INVALID SUBSCRIPTION DATA", {
                request_id: req.id
              });
              return;
            }

            await db.query(
              `
              UPDATE recurring_schedules
              SET status = 'ended',
                  canceled_at = now(),
                  end_date = CASE
                    WHEN $1 IS NULL THEN end_date
                    ELSE to_timestamp($1)
                  END
              WHERE stripe_subscription_id = $2
              `,
              [subscription.cancel_at || null, subscription.id]
            );

            logInfo("RECURRING SUBSCRIPTION ENDED", {
              request_id: req.id,
              stripe_subscription_id: subscription.id
            });
          } catch (error) {
            logError("SUBSCRIPTION DELETE SYNC FAILED", {
              request_id: req.id,
              error: error.message
            });
          }
        })();
        break;
      }
      case "customer.subscription.updated": {
        const subscription = event.data.object;

        (async () => {
          try {
            if (!subscription?.id) {
              logError("INVALID SUBSCRIPTION DATA", {
                request_id: req.id
              });
              return;
            }

            const status =
              subscription.status === "canceled"
                ? "ended"
                : subscription.cancel_at_period_end
                ? "canceled"
                : "active";

            await db.query(
              `
              UPDATE recurring_schedules
              SET status = $1,
                  end_date = CASE
                    WHEN $2 IS NULL THEN end_date
                    ELSE to_timestamp($2)
                  END
              WHERE stripe_subscription_id = $3
              `,
              [status, subscription.cancel_at || null, subscription.id]
            );

            logInfo("RECURRING SUBSCRIPTION UPDATED", {
              request_id: req.id,
              stripe_subscription_id: subscription.id,
              status
            });
          } catch (error) {
            logError("SUBSCRIPTION UPDATE SYNC FAILED", {
              request_id: req.id,
              error: error.message
            });
          }
        })();
        break;
      }
      default:
        logInfo("WEBHOOK IGNORED", {
          request_id: req.id,
          event_type: event.type
        });
    }

    return res.status(200).json({ received: true });
  }
);

app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({
    service: "QuickGive API",
    status: "running",
    environment: process.env.NODE_ENV || "production",
    timestamp: new Date().toISOString()
  });
});

app.get("/health", async (req, res) => {
  try {
    res.status(200).json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.get("/ready", async (req, res) => {
  const missingEnv = [
    "DATABASE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "JWT_SECRET_CURRENT"
  ].filter((key) => !process.env[key]);

  if (missingEnv.length > 0) {
    return res.status(503).json({
      status: "not_ready",
      checks: {
        env: {
          ok: false,
          missing: missingEnv
        }
      },
      timestamp: new Date().toISOString()
    });
  }

  try {
    await db.query("SELECT 1");
    return res.status(200).json({
      status: "ready",
      checks: {
        env: { ok: true },
        db: { ok: true },
        stripe: { configured: true },
        supabase: { configured: true }
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(503).json({
      status: "not_ready",
      checks: {
        env: { ok: true },
        db: {
          ok: false,
          error: err.message
        }
      },
      timestamp: new Date().toISOString()
    });
  }
});

app.get("/schools/recommended", authOptional, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 6, 25);
    const params = [req.user?.id || null, limit];
    const { rows } = await db.query(
      `
      SELECT
        s.id,
        s.name,
        s.city,
        s.state,
        s.kind,
        s.mascot,
        s.about,
        s.featured_rank AS "featuredRank",
        CASE WHEN fs.user_id IS NULL THEN false ELSE true END AS "isFavorite",
        sr.relationship AS relationship,
        sam.status AS "parentAccessStatus",
        COUNT(DISTINCT o.id)::int AS "organizationCount",
        COUNT(DISTINCT CASE WHEN e.is_active IS TRUE AND e.start_at >= now() THEN e.id END)::int AS "upcomingEventCount"
      FROM schools s
      LEFT JOIN organizations o ON o.school_id = s.id
      LEFT JOIN events e ON e.school_id = s.id
      LEFT JOIN favorite_schools fs ON fs.school_id = s.id AND fs.user_id = $1
      LEFT JOIN school_relationships sr ON sr.school_id = s.id AND sr.user_id = $1
      LEFT JOIN school_access_memberships sam
        ON sam.school_id = s.id
       AND sam.user_id = $1
       AND sam.access_role = 'parent_guardian'
      GROUP BY s.id, fs.user_id, sr.relationship, sam.status
      ORDER BY
        CASE WHEN fs.user_id IS NULL THEN 1 ELSE 0 END,
        CASE sr.relationship
          WHEN 'student' THEN 0
          WHEN 'parent' THEN 1
          WHEN 'alumni' THEN 2
          WHEN 'supporter' THEN 3
          ELSE 4
        END,
        s.featured_rank ASC,
        s.name ASC
      LIMIT $2
      `,
      params
    );

    return res.json(rows);
  } catch (err) {
    logError("RECOMMENDED SCHOOLS FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/events", authOptional, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.query.school_id);
    const organizationId = normalizeOptionalUuid(req.query.organization_id);
    const campaignId = normalizeOptionalUuid(req.query.campaign_id);
    const visibility = normalizeEventVisibility(req.query.visibility);
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    const favoritesOnly = parseBoolean(req.query.favorites_only, false);
    const includePast = parseBoolean(req.query.include_past, false);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const params = [req.user?.id || null];
    const where = ["e.is_active IS TRUE"];

    if (!includePast) {
      where.push("COALESCE(e.end_at, e.start_at) >= now()");
    }
    if (schoolId) {
      params.push(schoolId);
      where.push(`e.school_id = $${params.length}`);
    }
    if (organizationId) {
      params.push(organizationId);
      where.push(`e.organization_id = $${params.length}`);
    }
    if (campaignId) {
      params.push(campaignId);
      where.push(`e.campaign_id = $${params.length}`);
    }
    if (visibility === "public") {
      where.push("e.visibility = 'public'");
    } else if (visibility === "parents") {
      where.push("e.visibility = 'parents'");
      where.push("sam.user_id IS NOT NULL");
    } else {
      where.push("(e.visibility = 'public' OR (e.visibility = 'parents' AND sam.user_id IS NOT NULL))");
    }
    if (category) {
      params.push(category);
      where.push(`e.category = $${params.length}`);
    }
    if (favoritesOnly && req.user?.id) {
      where.push("fs.user_id IS NOT NULL");
    }

    params.push(limit);
    const { rows } = await db.query(
      `
      SELECT
        e.id,
        e.school_id AS "schoolId",
        e.organization_id AS "organizationId",
        e.campaign_id AS "campaignId",
        e.name,
        e.team_name AS "teamName",
        e.opponent,
        e.location,
        e.start_at AS "startAt",
        e.end_at AS "endAt",
        e.visibility,
        e.category,
        e.details,
        COALESCE(e.qr_code_value, '') AS "storedQrCodeValue",
        COALESCE(e.suggested_amounts_json, '[]'::jsonb) AS "suggestedAmounts",
        s.name AS "schoolName",
        o.name AS "organizationName",
        CASE WHEN fs.user_id IS NULL THEN false ELSE true END AS "isFavoriteSchool",
        CASE WHEN sam.user_id IS NULL THEN false ELSE true END AS "hasParentAccess"
      FROM events e
      JOIN schools s ON s.id = e.school_id
      JOIN organizations o ON o.id = e.organization_id
      LEFT JOIN favorite_schools fs ON fs.school_id = e.school_id AND fs.user_id = $1
      LEFT JOIN school_access_memberships sam
        ON sam.school_id = e.school_id
       AND sam.user_id = $1
       AND sam.access_role = 'parent_guardian'
       AND sam.status = 'approved'
      WHERE ${where.join(" AND ")}
      ORDER BY
        CASE WHEN fs.user_id IS NULL THEN 1 ELSE 0 END,
        e.start_at ASC
      LIMIT $${params.length}
      `,
      params
    );

    return res.json(
      rows.map((row) => {
        const qrCodeValue =
          row.storedQrCodeValue && row.storedQrCodeValue.trim().length > 0
            ? row.storedQrCodeValue
            : `https://quickgive.com/event-support?token=${buildEventQrToken({
                id: row.id,
                school_id: row.schoolId,
                organization_id: row.organizationId,
                campaign_id: row.campaignId,
                start_at: row.startAt,
                end_at: row.endAt
              })}`;
        return {
          ...row,
          qrCodeValue
        };
      })
    );
  } catch (err) {
    logError("EVENTS FEED FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/schools", authOptional, async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const favoritesOnly = parseBoolean(req.query.favorites_only, false);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);

    const params = [req.user?.id || null];
    let sql = `
      SELECT
        s.id,
        s.name,
        s.city,
        s.state,
        s.kind,
        s.mascot,
        s.about,
        s.featured_rank AS "featuredRank",
        COUNT(DISTINCT o.id)::int AS "organizationCount",
        COUNT(DISTINCT CASE WHEN e.is_active IS TRUE AND e.start_at >= now() THEN e.id END)::int AS "upcomingEventCount",
        CASE WHEN fs.user_id IS NULL THEN false ELSE true END AS "isFavorite",
        sr.relationship AS relationship,
        sam.status AS "parentAccessStatus"
      FROM schools s
      LEFT JOIN organizations o ON o.school_id = s.id
      LEFT JOIN events e ON e.school_id = s.id
      LEFT JOIN favorite_schools fs ON fs.school_id = s.id AND fs.user_id = $1
      LEFT JOIN school_relationships sr ON sr.school_id = s.id AND sr.user_id = $1
      LEFT JOIN school_access_memberships sam
        ON sam.school_id = s.id
       AND sam.user_id = $1
       AND sam.access_role = 'parent_guardian'
    `;

    const where = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(s.name ILIKE $${params.length} OR s.city ILIKE $${params.length} OR COALESCE(s.mascot, '') ILIKE $${params.length})`);
    }
    if (favoritesOnly && req.user?.id) {
      where.push(`fs.user_id IS NOT NULL`);
    }
    if (where.length > 0) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }

    params.push(limit);
    sql += `
      GROUP BY s.id, fs.user_id, sr.relationship
      , sam.status
      ORDER BY
        CASE WHEN fs.user_id IS NULL THEN 1 ELSE 0 END,
        s.featured_rank ASC,
        s.name ASC
      LIMIT $${params.length}
    `;

    const { rows } = await db.query(sql, params);
    return res.json(rows);
  } catch (err) {
    logError("SCHOOLS FETCH FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/schools/:id", authOptional, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.params.id);
    if (!schoolId) {
      return res.status(400).json({ error: "Invalid school id" });
    }

    const schoolResult = await db.query(
      `
      SELECT
        s.id,
        s.name,
        s.city,
        s.state,
        s.kind,
        s.mascot,
        s.about,
        s.featured_rank AS "featuredRank",
        CASE WHEN fs.user_id IS NULL THEN false ELSE true END AS "isFavorite",
        sr.relationship AS relationship,
        sam.status AS "parentAccessStatus"
      FROM schools s
      LEFT JOIN favorite_schools fs ON fs.school_id = s.id AND fs.user_id = $2
      LEFT JOIN school_relationships sr ON sr.school_id = s.id AND sr.user_id = $2
      LEFT JOIN school_access_memberships sam
        ON sam.school_id = s.id
       AND sam.user_id = $2
       AND sam.access_role = 'parent_guardian'
      WHERE s.id = $1
      LIMIT 1
      `,
      [schoolId, req.user?.id || null]
    );

    const school = schoolResult.rows[0];
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }

    const organizationsResult = await db.query(
      `
      SELECT
        o.id,
        o.school_id AS "schoolId",
        o.name,
        o.category,
        o.description,
        COALESCE(
          json_agg(
            json_build_object(
              'id', c.id,
              'name', c.name,
              'description', c.description,
              'goalAmountCents', c.goal_amount_cents,
              'isActive', c.is_active
            )
            ORDER BY c.created_at DESC
          ) FILTER (WHERE c.id IS NOT NULL),
          '[]'::json
        ) AS campaigns
      FROM organizations o
      LEFT JOIN campaigns c ON c.organization_id = o.id
      WHERE o.school_id = $1
      GROUP BY o.id
      ORDER BY o.name ASC
      `,
      [schoolId]
    );

    const eventsResult = await db.query(
      `
      SELECT
        e.id,
        e.school_id AS "schoolId",
        e.organization_id AS "organizationId",
        e.campaign_id AS "campaignId",
        e.name,
        e.team_name AS "teamName",
        e.opponent,
        e.location,
        e.start_at AS "startAt",
        e.end_at AS "endAt",
        e.visibility,
        e.category,
        e.details,
        COALESCE(e.qr_code_value, '') AS "storedQrCodeValue",
        COALESCE(e.suggested_amounts_json, '[]'::jsonb) AS "suggestedAmounts",
        CASE WHEN sam.user_id IS NULL THEN false ELSE true END AS "hasParentAccess"
      FROM events e
      LEFT JOIN school_access_memberships sam
        ON sam.school_id = e.school_id
       AND sam.user_id = $2
       AND sam.access_role = 'parent_guardian'
       AND sam.status = 'approved'
      WHERE e.school_id = $1
        AND e.is_active IS TRUE
        AND e.start_at >= now()
        AND (e.visibility = 'public' OR (e.visibility = 'parents' AND sam.user_id IS NOT NULL))
      ORDER BY e.start_at ASC
      LIMIT 5
      `,
      [schoolId, req.user?.id || null]
    );

    const mappedEvents = eventsResult.rows.map((row) => ({
      ...row,
      qrCodeValue:
        row.storedQrCodeValue && row.storedQrCodeValue.trim().length > 0
          ? row.storedQrCodeValue
          : `https://quickgive.com/event-support?token=${buildEventQrToken({
              id: row.id,
              school_id: row.schoolId,
              organization_id: row.organizationId,
              campaign_id: row.campaignId,
              start_at: row.startAt,
              end_at: row.endAt
            })}`
    }));

    return res.json({
      ...school,
      organizations: organizationsResult.rows,
      events: mappedEvents
    });
  } catch (err) {
    logError("SCHOOL DETAIL FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/schools/:id/events", authOptional, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.params.id);
    if (!schoolId) {
      return res.status(400).json({ error: "Invalid school id" });
    }

    const visibility = normalizeEventVisibility(req.query.visibility);
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    const includePast = parseBoolean(req.query.include_past, false);
    const params = [schoolId, req.user?.id || null];
    const where = ["e.school_id = $1", "e.is_active IS TRUE"];

    if (!includePast) {
      where.push("COALESCE(e.end_at, e.start_at) >= now()");
    }
    if (visibility === "public") {
      where.push("e.visibility = 'public'");
    } else if (visibility === "parents") {
      where.push("e.visibility = 'parents'");
      where.push("sam.user_id IS NOT NULL");
    } else {
      where.push("(e.visibility = 'public' OR (e.visibility = 'parents' AND sam.user_id IS NOT NULL))");
    }
    if (category) {
      params.push(category);
      where.push(`e.category = $${params.length}`);
    }

    const { rows } = await db.query(
      `
      SELECT
        e.id,
        e.school_id AS "schoolId",
        e.organization_id AS "organizationId",
        e.campaign_id AS "campaignId",
        e.name,
        e.team_name AS "teamName",
        e.opponent,
        e.location,
        e.start_at AS "startAt",
        e.end_at AS "endAt",
        e.visibility,
        e.category,
        e.details,
        COALESCE(e.qr_code_value, '') AS "storedQrCodeValue",
        COALESCE(e.suggested_amounts_json, '[]'::jsonb) AS "suggestedAmounts",
        o.name AS "organizationName",
        CASE WHEN sam.user_id IS NULL THEN false ELSE true END AS "hasParentAccess"
      FROM events e
      JOIN organizations o ON o.id = e.organization_id
      LEFT JOIN school_access_memberships sam
        ON sam.school_id = e.school_id
       AND sam.user_id = $2
       AND sam.access_role = 'parent_guardian'
       AND sam.status = 'approved'
      WHERE ${where.join(" AND ")}
      ORDER BY e.start_at ASC
      `,
      params
    );

    return res.json(
      rows.map((row) => ({
        ...row,
        qrCodeValue:
          row.storedQrCodeValue && row.storedQrCodeValue.trim().length > 0
            ? row.storedQrCodeValue
            : `https://quickgive.com/event-support?token=${buildEventQrToken({
                id: row.id,
                school_id: row.schoolId,
                organization_id: row.organizationId,
                campaign_id: row.campaignId,
                start_at: row.startAt,
                end_at: row.endAt
              })}`
      }))
    );
  } catch (err) {
    logError("SCHOOL EVENTS FETCH FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/events/resolve-qr", authOptional, async (req, res) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    const payload = verifyEventQrToken(token);
    const { rows } = await db.query(
      `
      SELECT
        e.id,
        e.school_id AS "schoolId",
        e.organization_id AS "organizationId",
        e.campaign_id AS "campaignId",
        e.name,
        e.team_name AS "teamName",
        e.opponent,
        e.location,
        e.start_at AS "startAt",
        e.end_at AS "endAt",
        e.visibility,
        e.category,
        e.details,
        COALESCE(e.suggested_amounts_json, '[]'::jsonb) AS "suggestedAmounts",
        s.name AS "schoolName",
        o.name AS "organizationName"
      FROM events e
      JOIN schools s ON s.id = e.school_id
      JOIN organizations o ON o.id = e.organization_id
      LEFT JOIN school_access_memberships sam
        ON sam.school_id = e.school_id
       AND sam.user_id = $2
       AND sam.access_role = 'parent_guardian'
       AND sam.status = 'approved'
      WHERE e.id = $1
        AND e.is_active IS TRUE
        AND (e.visibility = 'public' OR (e.visibility = 'parents' AND sam.user_id IS NOT NULL))
      LIMIT 1
      `,
      [payload.eventId, req.user?.id || null]
    );

    const event = rows[0];
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    return res.json({
      event,
      donationTarget: {
        organizationId: event.organizationId,
        campaignId: event.campaignId,
        legacyCharityId: payload.legacyCharityId || event.organizationId
      },
      token
    });
  } catch (err) {
    logError("EVENT QR RESOLVE FAILED", { request_id: req.id, error: err.message });
    return res.status(400).json({ error: "Invalid or expired token" });
  }
});

app.get("/news", authOptional, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.query.school_id);
    const favoriteOnly = parseBoolean(req.query.favorite_only, false);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const params = [req.user?.id || null];
    const where = ["n.is_public IS TRUE"];

    if (schoolId) {
      params.push(schoolId);
      where.push(`n.school_id = $${params.length}`);
    }
    if (favoriteOnly && req.user?.id) {
      where.push("fs.user_id IS NOT NULL");
    }

    params.push(limit);
    const { rows } = await db.query(
      `
      SELECT
        n.id,
        n.school_id AS "schoolId",
        n.organization_id AS "organizationId",
        n.title,
        n.summary,
        n.category,
        n.published_at AS "publishedAt",
        s.name AS "schoolName",
        CASE WHEN fs.user_id IS NULL THEN false ELSE true END AS "isFavoriteSchool"
      FROM school_news n
      JOIN schools s ON s.id = n.school_id
      LEFT JOIN favorite_schools fs ON fs.school_id = n.school_id AND fs.user_id = $1
      WHERE ${where.join(" AND ")}
      ORDER BY n.published_at DESC
      LIMIT $${params.length}
      `,
      params
    );

    return res.json(rows);
  } catch (err) {
    logError("NEWS FETCH FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/me/schools/favorites", authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      `
      SELECT
        s.id,
        s.name,
        s.city,
        s.state,
        s.kind,
        s.mascot,
        s.about,
        fs.created_at AS "favoritedAt"
      FROM favorite_schools fs
      JOIN schools s ON s.id = fs.school_id
      WHERE fs.user_id = $1
      ORDER BY fs.created_at DESC
      `,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    logError("FAVORITE SCHOOLS FETCH FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/me/schools/:id/favorite", authRequired, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.params.id);
    if (!schoolId) {
      return res.status(400).json({ error: "Invalid school id" });
    }

    await db.query(
      `
      INSERT INTO favorite_schools (user_id, school_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, school_id) DO NOTHING
      `,
      [req.user.id, schoolId]
    );

    return res.json({ ok: true, schoolId, isFavorite: true });
  } catch (err) {
    logError("FAVORITE SCHOOL SAVE FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/me/schools/:id/favorite", authRequired, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.params.id);
    if (!schoolId) {
      return res.status(400).json({ error: "Invalid school id" });
    }

    await db.query(
      `DELETE FROM favorite_schools WHERE user_id = $1 AND school_id = $2`,
      [req.user.id, schoolId]
    );

    return res.json({ ok: true, schoolId, isFavorite: false });
  } catch (err) {
    logError("FAVORITE SCHOOL DELETE FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/me/schools/relationships", authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      `
      SELECT school_id AS "schoolId", relationship, updated_at AS "updatedAt"
      FROM school_relationships
      WHERE user_id = $1
      ORDER BY updated_at DESC
      `,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    logError("SCHOOL RELATIONSHIPS FETCH FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/me/schools/access", authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      `
      SELECT
        school_id AS "schoolId",
        access_role AS "accessRole",
        status,
        requested_at AS "requestedAt",
        approved_at AS "approvedAt",
        updated_at AS "updatedAt",
        notes
      FROM school_access_memberships
      WHERE user_id = $1
      ORDER BY updated_at DESC
      `,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    logError("SCHOOL ACCESS FETCH FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/me/schools/:id/parent-access", authRequired, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.params.id);
    if (!schoolId) {
      return res.status(400).json({ error: "Invalid school id" });
    }

    const { rows } = await db.query(
      `
      SELECT
        school_id AS "schoolId",
        access_role AS "accessRole",
        status,
        requested_at AS "requestedAt",
        approved_at AS "approvedAt",
        updated_at AS "updatedAt",
        notes
      FROM school_access_memberships
      WHERE user_id = $1
        AND school_id = $2
        AND access_role = 'parent_guardian'
      LIMIT 1
      `,
      [req.user.id, schoolId]
    );

    return res.json(
      rows[0] || {
        schoolId,
        accessRole: "parent_guardian",
        status: "none",
        requestedAt: null,
        approvedAt: null,
        updatedAt: null,
        notes: null
      }
    );
  } catch (err) {
    logError("PARENT ACCESS STATUS FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/me/schools/:id/parent-access/request", authRequired, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.params.id);
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 500) : null;
    if (!schoolId) {
      return res.status(400).json({ error: "Invalid school id" });
    }

    const schoolCheck = await db.query(`SELECT id FROM schools WHERE id = $1 LIMIT 1`, [schoolId]);
    if (schoolCheck.rowCount === 0) {
      return res.status(404).json({ error: "School not found" });
    }

    await db.query(
      `
      INSERT INTO school_relationships (user_id, school_id, relationship, updated_at)
      VALUES ($1, $2, 'parent', now())
      ON CONFLICT (user_id, school_id)
      DO UPDATE SET relationship = 'parent', updated_at = now()
      `,
      [req.user.id, schoolId]
    );

    const existing = await db.query(
      `
      SELECT status
      FROM school_access_memberships
      WHERE user_id = $1
        AND school_id = $2
        AND access_role = 'parent_guardian'
      LIMIT 1
      `,
      [req.user.id, schoolId]
    );

    if (existing.rows[0]?.status === "approved") {
      return res.json({
        ok: true,
        schoolId,
        accessRole: "parent_guardian",
        status: "approved"
      });
    }

    await db.query(
      `
      INSERT INTO school_access_memberships (
        user_id,
        school_id,
        access_role,
        status,
        requested_at,
        approved_at,
        updated_at,
        approved_by_user_id,
        notes
      )
      VALUES ($1, $2, 'parent_guardian', 'pending', now(), NULL, now(), NULL, $3)
      ON CONFLICT (user_id, school_id, access_role)
      DO UPDATE SET
        status = 'pending',
        requested_at = now(),
        approved_at = NULL,
        updated_at = now(),
        approved_by_user_id = NULL,
        notes = EXCLUDED.notes
      `,
      [req.user.id, schoolId, notes]
    );

    return res.json({
      ok: true,
      schoolId,
      accessRole: "parent_guardian",
      status: "pending"
    });
  } catch (err) {
    logError("PARENT ACCESS REQUEST FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/me/schools/:id/relationship", authRequired, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.params.id);
    const relationship = normalizeRelationship(req.body?.relationship);
    if (!schoolId) {
      return res.status(400).json({ error: "Invalid school id" });
    }
    if (!relationship) {
      return res.status(400).json({ error: "Invalid relationship" });
    }

    await db.query(
      `
      INSERT INTO school_relationships (user_id, school_id, relationship, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (user_id, school_id)
      DO UPDATE SET relationship = EXCLUDED.relationship, updated_at = now()
      `,
      [req.user.id, schoolId, relationship]
    );

    return res.json({ ok: true, schoolId, relationship });
  } catch (err) {
    logError("SCHOOL RELATIONSHIP SAVE FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/internal/schools/:id/parent-access/:userId/approve", requireAccessAdmin, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.params.id);
    const userId = normalizeOptionalUuid(req.params.userId);
    if (!schoolId || !userId) {
      return res.status(400).json({ error: "Invalid school or user id" });
    }

    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 500) : null;
    const approvedByUserId = normalizeOptionalUuid(req.body?.approvedByUserId);

    await db.query(
      `
      INSERT INTO school_access_memberships (
        user_id,
        school_id,
        access_role,
        status,
        requested_at,
        approved_at,
        updated_at,
        approved_by_user_id,
        notes
      )
      VALUES ($1, $2, 'parent_guardian', 'approved', now(), now(), now(), $3, $4)
      ON CONFLICT (user_id, school_id, access_role)
      DO UPDATE SET
        status = 'approved',
        approved_at = now(),
        updated_at = now(),
        approved_by_user_id = $3,
        notes = COALESCE($4, school_access_memberships.notes)
      `,
      [userId, schoolId, approvedByUserId, notes]
    );

    await db.query(
      `
      INSERT INTO school_relationships (user_id, school_id, relationship, updated_at)
      VALUES ($1, $2, 'parent', now())
      ON CONFLICT (user_id, school_id)
      DO UPDATE SET relationship = 'parent', updated_at = now()
      `,
      [userId, schoolId]
    );

    return res.json({
      ok: true,
      schoolId,
      userId,
      accessRole: "parent_guardian",
      status: "approved"
    });
  } catch (err) {
    logError("PARENT ACCESS APPROVE FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/internal/schools/:id/parent-access/:userId/revoke", requireAccessAdmin, async (req, res) => {
  try {
    const schoolId = normalizeOptionalUuid(req.params.id);
    const userId = normalizeOptionalUuid(req.params.userId);
    const status = normalizeAccessStatus(req.body?.status) || "revoked";
    if (!schoolId || !userId) {
      return res.status(400).json({ error: "Invalid school or user id" });
    }
    if (!["pending", "revoked"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 500) : null;
    const approvedByUserId = normalizeOptionalUuid(req.body?.approvedByUserId);

    await db.query(
      `
      INSERT INTO school_access_memberships (
        user_id,
        school_id,
        access_role,
        status,
        requested_at,
        approved_at,
        updated_at,
        approved_by_user_id,
        notes
      )
      VALUES ($1, $2, 'parent_guardian', $3, now(), NULL, now(), $4, $5)
      ON CONFLICT (user_id, school_id, access_role)
      DO UPDATE SET
        status = $3,
        approved_at = NULL,
        updated_at = now(),
        approved_by_user_id = $4,
        notes = COALESCE($5, school_access_memberships.notes)
      `,
      [userId, schoolId, status, approvedByUserId, notes]
    );

    return res.json({
      ok: true,
      schoolId,
      userId,
      accessRole: "parent_guardian",
      status
    });
  } catch (err) {
    logError("PARENT ACCESS REVOKE FAILED", { request_id: req.id, error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/auth/signup", authLimiter, async (req, res) => {
  try {
    const { email, password, fullName } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }
    console.log("AUTH SIGNUP REQUEST", { email });
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = randomUUID();

    const result = await db.query(
      `
      INSERT INTO users (id, email, password_hash, full_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email
      `,
      [userId, email, passwordHash, fullName || null]
    );

    if (result.rowCount === 0) {
      console.log("AUTH SIGNUP DUPLICATE EMAIL", { email });
      return res.status(409).json({ error: "Email already exists" });
    }

    console.log("AUTH SIGNUP SAVED", { userId: result.rows[0].id, email });
    const token = signToken(result.rows[0].id, result.rows[0].email);
    return res.json({
      userId: result.rows[0].id,
      email: result.rows[0].email,
      token
    });
  } catch (err) {
    console.error("SIGNUP FAILED:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/auth/signin", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }
    console.log("AUTH SIGNIN REQUEST", { email });
    const { rows } = await db.query(
      `
      SELECT id, email, password_hash
      FROM users
      WHERE email = $1
      `,
      [email]
    );

    const user = rows[0];
    if (!user || !user.password_hash) {
      console.log("AUTH SIGNIN NO USER", { email });
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      console.log("AUTH SIGNIN BAD PASSWORD", { email });
      return res.status(401).json({ error: "invalid_credentials" });
    }

    console.log("AUTH SIGNIN OK", { userId: user.id, email: user.email });
    const token = signToken(user.id, user.email);
    return res.json({ userId: user.id, email: user.email, token });
  } catch (err) {
    console.error("SIGNIN FAILED:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/auth/google", authLimiter, async (req, res) => {
  try {
    const { idToken, fullName } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ error: "Missing idToken" });
    }

    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID
      });
    } catch (err) {
      logError("GOOGLE TOKEN VERIFY FAILED", { error: err.message });
      return res.status(401).json({ error: "Invalid Google token" });
    }

    const payload = ticket.getPayload();
    const email = payload?.email;
    const googleSub = payload?.sub;
    if (!email) {
      return res.status(400).json({ error: "Missing email from Google" });
    }
    if (!googleSub) {
      return res.status(400).json({ error: "Missing Google subject" });
    }

    const existingByGoogleSub = await db.query(
      `
      SELECT id, email, google_sub
      FROM users
      WHERE google_sub = $1
      LIMIT 1
      `,
      [googleSub]
    );

    let userId;
    if (existingByGoogleSub.rowCount > 0) {
      userId = existingByGoogleSub.rows[0].id;
    } else {
      const existingByEmail = await db.query(
        `
        SELECT id, email, google_sub
        FROM users
        WHERE email = $1
        LIMIT 1
        `,
        [email]
      );

      if (existingByEmail.rowCount > 0) {
        userId = existingByEmail.rows[0].id;
        if (!existingByEmail.rows[0].google_sub) {
          await db.query(
            `
            UPDATE users
            SET google_sub = $1,
                auth_provider = 'google',
                full_name = COALESCE(full_name, $2)
            WHERE id = $3
            `,
            [googleSub, fullName || payload?.name || null, userId]
          );
        }
      } else {
        userId = randomUUID();
        const placeholderHash = await bcrypt.hash(randomUUID(), 10);
        await db.query(
          `
          INSERT INTO users (id, email, password_hash, full_name, auth_provider, google_sub)
          VALUES ($1, $2, $3, $4, 'google', $5)
          `,
          [userId, email, placeholderHash, fullName || payload?.name || null, googleSub]
        );
      }
    }

    const token = signToken(userId, email);
    return res.json({ userId, email, token });
  } catch (err) {
    logError("AUTH GOOGLE FAILED", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/auth/apple", authLimiter, async (req, res) => {
  try {
    const { idToken, fullName } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ error: "Missing idToken" });
    }

    let payload;
    try {
      const result = await jwtVerify(idToken, appleJwks, {
        audience: process.env.APPLE_CLIENT_ID,
        issuer: "https://appleid.apple.com"
      });
      payload = result.payload;
    } catch (err) {
      logError("APPLE TOKEN VERIFY FAILED", { error: err.message });
      return res.status(401).json({ error: "Invalid Apple token" });
    }

    const appleSub = payload?.sub;
    const email = payload?.email || null;
    if (!appleSub) {
      return res.status(400).json({ error: "Missing apple sub" });
    }

    let userId;
    let userEmail = email;
    const bySub = await db.query(
      `SELECT id, email FROM users WHERE apple_sub = $1 LIMIT 1`,
      [appleSub]
    );
    if (bySub.rowCount > 0) {
      userId = bySub.rows[0].id;
      userEmail = bySub.rows[0].email;
    } else if (email) {
      const byEmail = await db.query(
        `SELECT id, email FROM users WHERE email = $1 LIMIT 1`,
        [email]
      );
      if (byEmail.rowCount > 0) {
        userId = byEmail.rows[0].id;
        userEmail = byEmail.rows[0].email;
        await db.query(
          `
          UPDATE users
          SET apple_sub = $1,
              auth_provider = 'apple',
              full_name = COALESCE(full_name, $2)
          WHERE id = $3
          `,
          [appleSub, fullName || null, userId]
        );
      } else {
        userId = randomUUID();
        const placeholderHash = await bcrypt.hash(randomUUID(), 10);
        await db.query(
          `
          INSERT INTO users (id, email, password_hash, full_name, auth_provider, apple_sub)
          VALUES ($1, $2, $3, $4, 'apple', $5)
          `,
          [userId, email, placeholderHash, fullName || null, appleSub]
        );
      }
    } else {
      return res.status(400).json({ error: "Email not provided by Apple" });
    }

    const token = signToken(userId, userEmail);
    return res.json({ userId, email: userEmail, token });
  } catch (err) {
    logError("AUTH APPLE FAILED", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/auth/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    const { rows } = await db.query(
      `SELECT id, email FROM users WHERE email = $1`,
      [email]
    );
    const user = rows[0];

    if (user) {
      const token = require("crypto").randomBytes(32).toString("hex");
      const tokenHash = require("crypto")
        .createHash("sha256")
        .update(token)
        .digest("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db.query(
        `
        INSERT INTO password_reset_tokens (
          id,
          user_id,
          token_hash,
          expires_at
        )
        VALUES ($1, $2, $3, $4)
        `,
        [randomUUID(), user.id, tokenHash, expiresAt.toISOString()]
      );

      const baseUrl = process.env.FRONTEND_RESET_URL_BASE;
      const resetUrl = `${baseUrl}/reset-password?token=${token}`;
      try {
        await sendPasswordResetEmail(user.email, resetUrl);
      } catch (err) {
        logError("PASSWORD RESET EMAIL FAILED", { error: err.message });
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    logError("FORGOT PASSWORD FAILED", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/auth/reset-password", authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({ error: "Missing token or password" });
    }

    const tokenHash = require("crypto")
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const { rows } = await db.query(
      `
      SELECT id, user_id, expires_at, used_at
      FROM password_reset_tokens
      WHERE token_hash = $1
      LIMIT 1
      `,
      [tokenHash]
    );

    const record = rows[0];
    if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await db.query("BEGIN");
    await db.query(
      `
      UPDATE users
      SET password_hash = $1
      WHERE id = $2
      `,
      [passwordHash, record.user_id]
    );
    await db.query(
      `
      UPDATE password_reset_tokens
      SET used_at = now()
      WHERE id = $1
      `,
      [record.id]
    );
    await db.query("COMMIT");

    return res.json({ ok: true });
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    logError("RESET PASSWORD FAILED", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/recurring/setup-intent", authRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    const email = req.user?.email;
    if (!userId || !email) {
      logError("AUTH FAILURE", { reason: "missing_email", request_id: req.id });
      return res.status(400).json({ error: "Missing authenticated user email" });
    }
    const customerId = await getOrCreateStripeCustomerForUser({
      userId,
      email,
    });

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      metadata: {
        user_id: userId,
        email
      }
    });

    return res.json({
      client_secret: setupIntent.client_secret,
      customer_id: customerId
    });
  } catch (err) {
    logError("RECURRING SETUP INTENT FAILED", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/recurring", authRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    const {
      organization_id,
      campaign_id,
      charity_id,
      charity_name,
      amount_cents,
      frequency,
      start_date,
      end_date,
      currency
    } = req.body || {};

    if (!userId || !charity_id || !charity_name || !amount_cents || amount_cents <= 0) {
      return res.status(400).json({ error: "Missing or invalid fields" });
    }
    if (!req.user?.email) {
      logError("AUTH FAILURE", { reason: "missing_email", request_id: req.id });
      return res.status(400).json({ error: "Missing authenticated user email" });
    }
    if (!["weekly", "monthly"].includes(frequency)) {
      return res.status(400).json({ error: "Invalid frequency" });
    }

    const startDate = new Date(start_date);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: "Invalid start_date" });
    }
    let endDate = null;
    if (end_date) {
      endDate = new Date(end_date);
      if (Number.isNaN(endDate.getTime())) {
        return res.status(400).json({ error: "Invalid end_date" });
      }
      if (endDate < startDate) {
        return res.status(400).json({ error: "end_date must be >= start_date" });
      }
    }

    const customerId = await getOrCreateStripeCustomerForUser({
      userId,
      email: req.user.email,
    });

    const defaultPaymentMethod = await ensureCustomerDefaultPaymentMethod(customerId);
    if (!defaultPaymentMethod) {
      return res
        .status(400)
        .json({ error: "No default payment method on customer" });
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const startUnix = Math.floor(startDate.getTime() / 1000);
    const cancelAtUnix = endDate ? Math.floor(endDate.getTime() / 1000) : null;

    const subscriptionCurrency = currency || "usd";
    let subscription;
    try {
      subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [
          {
            price_data: {
              currency: subscriptionCurrency,
              unit_amount: amount_cents,
              recurring: { interval: frequency }
            }
          }
        ],
        metadata: {
          user_id: userId,
          organization_id: organization_id || "",
          campaign_id: campaign_id || "",
          charity_id,
          charity_name,
          email: req.user.email || ""
        },
        collection_method: "charge_automatically",
        default_payment_method: defaultPaymentMethod,
        ...(startUnix > nowUnix ? { trial_end: startUnix } : {}),
        ...(cancelAtUnix ? { cancel_at: cancelAtUnix } : {})
      });

      const { rows } = await db.query(
        `
        INSERT INTO recurring_schedules (
          id,
          donor_id,
          user_id,
          organization_id,
          campaign_id,
          charity_id,
          charity_name,
          frequency,
          amount_cents,
          currency,
          start_date,
          end_date,
          stripe_customer_id,
          stripe_subscription_id,
          status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING *
        `,
        [
          randomUUID(),
          userId,
          userId,
          normalizeOptionalUuid(organization_id),
          normalizeOptionalUuid(campaign_id),
          charity_id,
          charity_name,
          frequency,
          amount_cents,
          subscriptionCurrency,
          startDate.toISOString(),
          endDate ? endDate.toISOString() : null,
          customerId,
          subscription.id,
          "active"
        ]
      );

      return res.json(rows[0]);
    } catch (err) {
      if (subscription?.id) {
        try {
          await stripe.subscriptions.del(subscription.id);
          logInfo("RECURRING SUBSCRIPTION ROLLED BACK", {
            request_id: req.id,
            stripe_subscription_id: subscription.id
          });
        } catch (cancelErr) {
          logError("RECURRING ROLLBACK FAILED", {
            request_id: req.id,
            stripe_subscription_id: subscription.id,
            error: cancelErr.message
          });
        }
      }
      throw err;
    }
  } catch (err) {
    logError("RECURRING CREATE FAILED", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/recurring", authRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({ error: "Missing user_id" });
    }
    const { rows } = await db.query(
      `
      SELECT *
      FROM recurring_schedules
      WHERE donor_id = $1
      ORDER BY created_at DESC
      `,
      [userId]
    );
    return res.json(rows);
  } catch (err) {
    logError("RECURRING LIST FAILED", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/recurring/:id/cancel", authRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { rows } = await db.query(
      `
      SELECT *
      FROM recurring_schedules
      WHERE id = $1 AND donor_id = $2
      LIMIT 1
      `,
      [req.params.id, userId]
    );
    const schedule = rows[0];
    if (!schedule) {
      return res.status(404).json({ error: "Schedule not found" });
    }

    const cancelAtPeriodEnd = req.body?.cancel_at_period_end === true;
    let updated;
    if (cancelAtPeriodEnd) {
      updated = await stripe.subscriptions.update(
        schedule.stripe_subscription_id,
        { cancel_at_period_end: true }
      );
    } else {
      updated = await stripe.subscriptions.del(
        schedule.stripe_subscription_id
      );
    }

    const { rows: updatedRows } = await db.query(
      `
      UPDATE recurring_schedules
      SET status = $1,
          canceled_at = now(),
          end_date = CASE
            WHEN $2 IS NULL THEN end_date
            ELSE to_timestamp($2)
          END
      WHERE id = $3
      RETURNING *
      `,
      [
        cancelAtPeriodEnd ? "canceled" : "ended",
        updated.cancel_at || null,
        schedule.id
      ]
    );

    return res.json(updatedRows[0]);
  } catch (err) {
    logError("RECURRING CANCEL FAILED", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/create-payment-intent", authRequired, async (req, res) => {
  try {
    const {
      amount,
      currency = "usd",
      organization_id,
      campaign_id,
      charity_id,
      charity_name
    } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!charity_id || typeof charity_id !== "string") {
      return res.status(400).json({ error: "Missing charity_id" });
    }
    if (!charity_name || typeof charity_name !== "string" || !charity_name.trim()) {
      return res.status(400).json({ error: "Missing charity_name" });
    }

    const userId = req.user?.id;
    const userEmail = req.user?.email;
    if (!userId || !userEmail) {
      logError("AUTH FAILURE", { reason: "missing_email", request_id: req.id });
      return res.status(400).json({ error: "Missing authenticated user email" });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount, // cents
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        organization_id: normalizeOptionalUuid(organization_id) || "",
        campaign_id: normalizeOptionalUuid(campaign_id) || "",
        // Legacy charity fields remain for backward compatibility.
        charity_id,
        charity_name: charity_name.trim(),
        user_id: userId,
        email: userEmail,
        app: "Dono"
      }
    });

    res.json({ client_secret: paymentIntent.client_secret });
  } catch (err) {
    console.error("create-payment-intent error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/web/create-checkout-session", authRequired, async (req, res) => {
  try {
    const { organization_id, campaign_id, charity_id, amount } = req.query;
    const userId = req.user?.id;
    const userEmail = req.user?.email;

    if (
      (!organization_id || typeof organization_id !== "string") &&
      (!charity_id || typeof charity_id !== "string")
    ) {
      return res
        .status(400)
        .json({ error: "Missing organization_id or legacy charity_id" });
    }
    if (!userId || !userEmail) {
      return res.status(400).json({ error: "Missing authenticated user email" });
    }

    const amountCents = amount ? parseInt(amount, 10) : 1000;
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: userEmail,
      success_url: "https://quickgive.com/donation-success",
      cancel_url: "https://quickgive.com/donation-canceled",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "QuickGive Donation"
            },
            unit_amount: amountCents
          },
          quantity: 1
        }
      ],
      metadata: {
        organization_id: normalizeOptionalUuid(organization_id) || "",
        campaign_id: normalizeOptionalUuid(campaign_id) || "",
        charity_id: typeof charity_id === "string" ? charity_id : "",
        user_id: userId,
        email: userEmail
      }
    });

    return res.redirect(session.url);
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/donations", authRequired, async (req, res) => {
  console.log("🔥 /donations HIT", new Date().toISOString());
  try {
    const donorId = resolveDonorId(req);
    if (!donorId) {
      return res.status(400).json({ error: "Missing userId" });
    }
    const { rows } = await db.query(
      `
      SELECT
        id,
        amount_cents,
        currency,
        organization_id AS "organizationId",
        campaign_id AS "campaignId",
        charity_id AS "charityId",
        charity_name AS "charityName",
        user_id AS "donorId",
        stripe_payment_intent_id AS "paymentIntentId",
        created_at AS "createdAt"
      FROM donations
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [donorId]
    );
    res.json(rows);
  } catch (err) {
    console.error("DONATIONS FETCH FAILED:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/receipts", authRequired, async (req, res) => {
  try {
    const donorId = resolveDonorId(req);
    if (!donorId) {
      return res.status(400).json({ error: "Missing userId" });
    }
    const { rows } = await db.query(
      `
      SELECT
        r.id,
        r.donation_id AS "donationId",
        r.created_at AS "createdAt",
        r.tax_deductible AS "taxDeductible",
        d.amount_cents AS "amount_cents",
        d.currency,
        d.organization_id AS "organizationId",
        d.campaign_id AS "campaignId",
        d.charity_id AS "charityId",
        d.user_id AS "userId",
        d.stripe_payment_intent_id AS "paymentIntentId"
      FROM receipts r
      JOIN donations d ON d.id = r.donation_id
      WHERE d.user_id = $1
      ORDER BY r.created_at DESC
      `,
      [donorId]
    );
    res.json(rows);
  } catch (err) {
    console.error("RECEIPTS FETCH FAILED:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/receipts/:id/pdf", authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      `
      SELECT
        r.id,
        r.donation_id AS "donationId",
        r.created_at AS "createdAt",
        r.pdf_url AS "pdfUrl",
        d.amount_cents AS "amountCents",
        d.currency,
        d.charity_id AS "charityId",
        d.user_id AS "userId"
      FROM receipts r
      JOIN donations d ON d.id = r.donation_id
      WHERE r.id = $1::uuid
        AND d.user_id = $2
      LIMIT 1
      `,
      [req.params.id, req.user.id]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: "receipt not found" });
    }

    const donation = {
      id: row.donationId,
      amount: Number(row.amountCents || 0) / 100,
      currency: row.currency || "usd",
      charityId: row.charityId,
      donorId: row.userId,
      createdAt: row.createdAt
    };
    const receipt = {
      id: row.id,
      donationId: row.donationId,
      amount: donation.amount,
      currency: donation.currency,
      charityId: donation.charityId,
      userId: donation.donorId,
      createdAt: row.createdAt,
      taxDeductible: true
    };

    const storagePath = `receipts/${row.id}.pdf`;
    let signed = await supabase.storage
      .from("receipts")
      .createSignedUrl(storagePath, 600);

    if (signed.error || !signed.data?.signedUrl) {
      // If the PDF does not exist in storage yet, generate and upload it on demand.
      const pdfBuffer = await generateReceiptPdf(receipt, donation);
      const upload = await supabase.storage
        .from("receipts")
        .upload(storagePath, pdfBuffer, {
          contentType: "application/pdf",
          upsert: true
        });

      if (upload.error) {
        console.error("RECEIPT PDF UPLOAD FAILED:", upload.error);
        return res.status(404).json({ error: "receipt pdf not found" });
      }

      signed = await supabase.storage
        .from("receipts")
        .createSignedUrl(storagePath, 600);

      if (signed.error || !signed.data?.signedUrl) {
        console.error("RECEIPT SIGNED URL FAILED:", signed.error);
        return res.status(404).json({ error: "receipt pdf not found" });
      }
    }

    return res.redirect(signed.data.signedUrl);
  } catch (err) {
    console.error("RECEIPT PDF FAILED:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/tax-summary", authRequired, async (req, res) => {
  try {
    const donorId = resolveDonorId(req);
    if (!donorId) {
      return res.status(400).json({ error: "Missing userId" });
    }
    const { rows } = await db.query(
      `
      SELECT
        EXTRACT(YEAR FROM d.created_at)::int AS year,
        SUM(d.amount_cents) / 100.0 AS totalAmount,
        SUM(
          CASE
            WHEN r.tax_deductible IS TRUE THEN d.amount_cents
            ELSE 0
          END
        ) / 100.0 AS deductibleAmount,
        COUNT(*) AS donationCount
      FROM donations d
      LEFT JOIN receipts r ON r.donation_id = d.id
      WHERE d.user_id = $1
      GROUP BY year
      ORDER BY year DESC
      `,
      [donorId]
    );
    res.json(rows);
  } catch (err) {
    console.error("TAX SUMMARY FETCH FAILED:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/tax-summary/:year/pdf", authRequired, async (req, res) => {
  const year = parseInt(req.params.year, 10);
  try {
    const donorId = resolveDonorId(req);
    if (!donorId) {
      return res.status(400).json({ error: "Missing userId" });
    }
    const { rows } = await db.query(
      `
      SELECT
        SUM(d.amount_cents) / 100.0 AS totalAmount,
        SUM(
          CASE
            WHEN r.tax_deductible IS TRUE THEN d.amount_cents
            ELSE 0
          END
        ) / 100.0 AS deductibleAmount,
        COUNT(*) AS donationCount
      FROM donations d
      LEFT JOIN receipts r ON r.donation_id = d.id
      WHERE EXTRACT(YEAR FROM d.created_at)::int = $1
        AND d.user_id = $2
      `,
      [year, donorId]
    );

    const summary = rows[0] || {
      totalamount: 0,
      deductibleamount: 0,
      donationcount: 0
    };

    const totalAmount = Number(summary.totalamount || summary.totalAmount || 0);
    const deductibleAmount = Number(
      summary.deductibleamount || summary.deductibleAmount || 0
    );
    const donationCount = Number(
      summary.donationcount || summary.donationCount || 0
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");

    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    doc.pipe(res);

    doc.fontSize(20).text("Dono Tax Summary", { align: "left" });
    doc.moveDown();
    doc.fontSize(12).text(`Year: ${year}`);
    doc.text(`Total Donated: $${totalAmount}`);
    doc.text(`Total Deductible: $${deductibleAmount}`);
    doc.text(`Donation Count: ${donationCount}`);
    doc.moveDown();
    doc.text("Disclaimer: This summary is not tax advice.");

    doc.end();
  } catch (err) {
    console.error("TAX SUMMARY PDF FAILED:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

setInterval(() => {
  logInfo("METRICS", {
    uptime_seconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    requests: metrics.requests,
    errors: metrics.errors,
    webhook_failures: metrics.webhookFailures,
    payment_failures: metrics.paymentFailures
  });
}, parseInt(process.env.METRICS_LOG_INTERVAL_MS || "60000", 10));

// Sentry error handler must be registered before any other error middleware
Sentry.setupExpressErrorHandler(app);

// Centralized error handler
app.use((err, req, res, next) => {
  metrics.errors += 1;
  logError("UNHANDLED ERROR", {
    request_id: req.id,
    user_id: req.user?.id || null,
    donation_id: req.donationId || null,
    error: err.message
  });
  res.status(500).json({ error: "Internal server error" });
});

const port = process.env.PORT || 4242;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
