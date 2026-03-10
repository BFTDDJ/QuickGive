require("./instrument");
require("dotenv").config();
const db = require("./db");
const { randomUUID } = require("crypto");
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

async function getOrCreateStripeCustomer({ donorId, email, userId }) {
  if (userId) {
    const { rows } = await db.query(
      `SELECT stripe_customer_id FROM users WHERE id = $1`,
      [userId]
    );
    const existing = rows[0]?.stripe_customer_id;
    if (existing) return existing;
  } else {
    const { rows } = await db.query(
      `SELECT stripe_customer_id FROM donor_stripe_customers WHERE donor_id = $1`,
      [donorId]
    );
    const existing = rows[0]?.stripe_customer_id;
    if (existing) return existing;
  }

  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { donor_id: donorId }
  });

  if (userId) {
    await db.query(
      `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
      [customer.id, userId]
    );
  } else {
    await db.query(
      `
      INSERT INTO donor_stripe_customers (donor_id, stripe_customer_id)
      VALUES ($1, $2)
      ON CONFLICT (donor_id) DO NOTHING
      `,
      [donorId, customer.id]
    );
  }

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

// Allow your iOS app to call this endpoint (for demo use *)
app.use(cors());

// Request ID + request logging
app.use((req, res, next) => {
  req.id = randomUUID();
  metrics.requests += 1;
  logInfo("REQUEST", {
    request_id: req.id,
    method: req.method,
    path: req.path
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

// TEMP auth header logging (remove after debugging)
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  const donorHeader = req.headers["x-donor-id"];
  logInfo("REQ HEADERS", {
    request_id: req.id,
    authorization: authHeader || null,
    "x-donor-id": donorHeader || null
  });
  next();
});

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
            const donorId = paymentIntent?.metadata?.user_id || null;
            const charityId = paymentIntent?.metadata?.charity_id || null;
            const amountCents = paymentIntent?.amount_received || 0;
            const currency = paymentIntent?.currency || "usd";
            const stripePaymentIntentId = paymentIntent?.id || null;

            if (!donorId || !charityId || !stripePaymentIntentId || amountCents <= 0) {
              logError("WEBHOOK DONATION SKIPPED INVALID DATA", {
                request_id: req.id,
                stripe_payment_intent_id: stripePaymentIntentId,
                donor_id: donorId,
                charity_id: charityId,
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
                charity_id,
                user_id,
                stripe_payment_intent_id,
                created_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, now())
              ON CONFLICT (stripe_payment_intent_id) DO NOTHING
              RETURNING id
              `,
              [
                randomUUID(),
                amountCents,
                currency,
                charityId,
                donorId,
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
                charity_id,
                user_id,
                stripe_payment_intent_id,
                created_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, now())
              ON CONFLICT (stripe_payment_intent_id) DO NOTHING
              RETURNING id
              `,
              [
                donationId,
                invoice.amount_paid,
                invoice.currency || "usd",
                schedule.charity_id,
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
    if (!email) {
      return res.status(400).json({ error: "Missing email from Google" });
    }

    const existing = await db.query(
      `SELECT id, email FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    let userId;
    if (existing.rowCount > 0) {
      userId = existing.rows[0].id;
    } else {
      userId = randomUUID();
      await db.query(
        `
        INSERT INTO users (id, email, full_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (email) DO NOTHING
        `,
        [userId, email, fullName || payload?.name || null]
      );
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
        await db.query(`UPDATE users SET apple_sub = $1 WHERE id = $2`, [
          appleSub,
          userId
        ]);
      } else {
        userId = randomUUID();
        await db.query(
          `
          INSERT INTO users (id, email, full_name, apple_sub)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (apple_sub) DO NOTHING
          `,
          [userId, email, fullName || null, appleSub]
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
    const donorId = req.user?.id;
    const email = req.user?.email;
    if (!email) {
      logError("AUTH FAILURE", { reason: "missing_email", request_id: req.id });
      return res.status(400).json({ error: "Missing user email" });
    }
    const customerId = await getOrCreateStripeCustomer({
      donorId,
      email,
      userId: req.user?.id || null
    });

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      metadata: {
        donor_id: donorId,
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
    const donorId = req.user?.id;
    const {
      charity_id,
      amount_cents,
      frequency,
      start_date,
      end_date,
      currency
    } = req.body || {};

    if (!donorId || !charity_id || !amount_cents || amount_cents <= 0) {
      return res.status(400).json({ error: "Missing or invalid fields" });
    }
    if (!req.user?.email) {
      logError("AUTH FAILURE", { reason: "missing_email", request_id: req.id });
      return res.status(400).json({ error: "Missing user email" });
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

    const customerId = await getOrCreateStripeCustomer({
      donorId,
      email: req.user.email,
      userId: req.user?.id || null
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
          donor_id: donorId,
          charity_id,
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
          charity_id,
          frequency,
          amount_cents,
          currency,
          start_date,
          end_date,
          stripe_customer_id,
          stripe_subscription_id,
          status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
        `,
        [
          randomUUID(),
          donorId,
          req.user?.id || donorId,
          charity_id,
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
    const donorId = req.user?.id;
    if (!donorId) {
      return res.status(400).json({ error: "Missing donor_id" });
    }
    const { rows } = await db.query(
      `
      SELECT *
      FROM recurring_schedules
      WHERE donor_id = $1
      ORDER BY created_at DESC
      `,
      [donorId]
    );
    return res.json(rows);
  } catch (err) {
    logError("RECURRING LIST FAILED", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/recurring/:id/cancel", authRequired, async (req, res) => {
  try {
    const donorId = req.user?.id;
    const { rows } = await db.query(
      `
      SELECT *
      FROM recurring_schedules
      WHERE id = $1 AND donor_id = $2
      LIMIT 1
      `,
      [req.params.id, donorId]
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
    const { amount, currency = "usd", charity_id, user_id, email } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!charity_id || typeof charity_id !== "string") {
      return res.status(400).json({ error: "Missing charity_id" });
    }

    const donorId = req.user?.id;
    const userEmail = req.user?.email;
    if (!userEmail) {
      logError("AUTH FAILURE", { reason: "missing_email", request_id: req.id });
      return res.status(400).json({ error: "Missing user email" });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount, // cents
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        charity_id,
        user_id: donorId,
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

app.get("/donations", authOptional, async (req, res) => {
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
        charity_id AS "charityId",
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

app.get("/receipts", authOptional, async (req, res) => {
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

app.get("/receipts/:id/pdf", async (req, res) => {
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
      LIMIT 1
      `,
      [req.params.id]
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

app.get("/tax-summary", authOptional, async (req, res) => {
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

app.get("/tax-summary/:year/pdf", authOptional, async (req, res) => {
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
