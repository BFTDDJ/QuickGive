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
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Sentry = require("@sentry/node");

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
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()
    `
  );
  await db.query(
    `
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (email)
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
    return res.status(401).json({ error: "Missing token" });
  }
  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (err) {
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

// Stripe webhook must use raw body
app.use("/stripe/webhook", webhookLimiter, express.raw({ type: "application/json" }));

// JSON parsing for everything else
const jsonParser = express.json();
app.use((req, res, next) => {
  if (req.originalUrl === "/stripe/webhook") {
    return next();
  }
  return jsonParser(req, res, next);
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
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      console.log("AUTH SIGNIN BAD PASSWORD", { email });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    console.log("AUTH SIGNIN OK", { userId: user.id, email: user.email });
    const token = signToken(user.id, user.email);
    return res.json({ userId: user.id, email: user.email, token });
  } catch (err) {
    console.error("SIGNIN FAILED:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/create-payment-intent", authOptional, async (req, res) => {
  try {
    const { amount, currency = "usd", charity_id, user_id, email } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!charity_id || typeof charity_id !== "string") {
      return res.status(400).json({ error: "Missing charity_id" });
    }

    const donorId = resolveDonorId(req);
    const paymentIntent = await stripe.paymentIntents.create({
      amount, // cents
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        charity_id,
        user_id: donorId ?? user_id ?? undefined,
        email,
        app: "Dono"
      }
    });

    res.json({ client_secret: paymentIntent.client_secret });
  } catch (err) {
    console.error("create-payment-intent error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/stripe/webhook", (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    metrics.webhookFailures += 1;
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send("Webhook Error");
  }

  if (event.type !== "payment_intent.succeeded") {
    logInfo("WEBHOOK IGNORED", {
      request_id: req.id,
      event_type: event.type
    });
    return res.json({ received: true });
  }

  const paymentIntent = event.data?.object;
  if (!paymentIntent || !paymentIntent.id) {
    metrics.paymentFailures += 1;
    logError("INVALID PAYMENT INTENT DATA", { request_id: req.id });
    return res.json({ received: true });
  }

  const donorId = paymentIntent.metadata?.user_id || randomUUID();
  const donorEmail = paymentIntent.metadata?.email || null;
  const charityId = paymentIntent.metadata?.charity_id;
  const amountReceived = paymentIntent.amount_received;
  const currency = paymentIntent.currency || "usd";

  if (!charityId || !amountReceived || amountReceived <= 0) {
    metrics.paymentFailures += 1;
    logError("INVALID DONATION DATA", {
      request_id: req.id,
      stripe_payment_intent_id: paymentIntent.id,
      donor_id: donorId,
      amount: amountReceived,
      charity_id: charityId
    });
    return res.json({ received: true });
  }

  logInfo("WEBHOOK RECEIVED", {
    request_id: req.id,
    stripe_payment_intent_id: paymentIntent.id,
    donor_id: donorId,
    amount: amountReceived,
    charity_id: charityId
  });

  const donation = {
    id: randomUUID(),
    amount: amountReceived / 100,
    currency,
    charityId,
    donorId,
    paymentIntentId: paymentIntent.id,
    createdAt: new Date().toISOString()
  };

  const receipt = {
    id: randomUUID(),
    donationId: donation.id
  };

  (async () => {
    try {
      if (donorEmail) {
        await db.query(
          `
          INSERT INTO users (id, email)
          VALUES ($1, $2)
          ON CONFLICT (id) DO NOTHING
          `,
          [donation.donorId, donorEmail]
        );
      } else {
        console.log("SKIP USER INSERT (NO EMAIL)", { donor_id: donation.donorId });
      }

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
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (stripe_payment_intent_id) DO NOTHING
        RETURNING id
        `,
        [
          donation.id,
          amountReceived,
          donation.currency,
          donation.charityId,
          donation.donorId,
          donation.paymentIntentId,
          donation.createdAt
        ]
      );

      if (donationInsert.rowCount === 0) {
        logInfo("DUPLICATE PAYMENT INTENT IGNORED", {
          request_id: req.id,
          stripe_payment_intent_id: donation.paymentIntentId,
          donor_id: donation.donorId,
          amount: amountReceived,
          charity_id: charityId
        });
        return;
      }

      await db.query(
        `
        INSERT INTO receipts (
          id,
          donation_id,
          created_at
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (donation_id) DO NOTHING
        `,
        [receipt.id, receipt.donationId, new Date().toISOString()]
      );

      try {
        const receiptForPdf = {
          id: receipt.id,
          donationId: receipt.donationId,
          createdAt: new Date().toISOString(),
          taxDeductible: true
        };

        let pdfBuffer = await generateReceiptPdf(receiptForPdf, donation);
        const storagePath = `receipts/${receipt.id}.pdf`;

        const uploadResult = await supabase.storage
          .from("receipts")
          .upload(storagePath, pdfBuffer, {
            contentType: "application/pdf",
            upsert: true
          });

        pdfBuffer = null;

        if (uploadResult.error) {
          console.error("RECEIPT PDF UPLOAD FAILED:", uploadResult.error);
        } else {
          const signed = await supabase.storage
            .from("receipts")
            .createSignedUrl(storagePath, 600);

          if (signed.error) {
            console.error("RECEIPT SIGNED URL FAILED:", signed.error);
          } else if (signed.data?.signedUrl) {
            await db.query(
              `
              UPDATE receipts
              SET pdf_url = $1
              WHERE id = $2
              `,
              [signed.data.signedUrl, receipt.id]
            );
          }
        }
      } catch (err) {
        console.error("RECEIPT PDF PROCESS FAILED:", err);
      }

      logInfo("DONATION AND RECEIPT SAVED TO DB", {
        request_id: req.id,
        donation_id: donation.id,
        donor_id: donation.donorId,
        stripe_payment_intent_id: donation.paymentIntentId
      });
    } catch (err) {
      logError("DB SAVE FAILED", {
        request_id: req.id,
        donor_id: donation.donorId,
        stripe_payment_intent_id: donation.paymentIntentId,
        error: err.message
      });
    }
  })();

  res.json({ received: true });
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
        r.pdf_url AS "pdfUrl"
      FROM receipts r
      WHERE r.id = $1::uuid
      LIMIT 1
      `,
      [req.params.id]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: "receipt not found" });
    }

    const storagePath = `receipts/${row.id}.pdf`;
    const signed = await supabase.storage
      .from("receipts")
      .createSignedUrl(storagePath, 600);

    if (signed.error || !signed.data?.signedUrl) {
      console.error("RECEIPT SIGNED URL FAILED:", signed.error);
      return res.status(404).json({ error: "receipt pdf not found" });
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

app.listen(process.env.PORT || 4242, () => {
  console.log(`Server running on port ${process.env.PORT || 4242}`);
});
