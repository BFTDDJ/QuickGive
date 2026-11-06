# QuickGive

Backend API for a donation app: donor accounts, Stripe payments, PDF receipts, and yearly tax
summaries. Client apps call this service; no frontend lives in this repo.

> Internally the service and its documents use the name **Dono** (`dono-backend` in
> `package.json`, "Dono Receipt" on PDFs).

## Stack

Node.js, Express 5, PostgreSQL (`pg`), Stripe, Supabase Storage, PDFKit, Sentry, and optional
Datadog tracing.

## Getting started

### Prerequisites

- Node.js and npm
- A PostgreSQL database that accepts TLS connections (`db.js` always connects over SSL)
- A Stripe account
- A Supabase project with a storage bucket named `receipts`

### Setup

```bash
npm install
```

Create a `.env` file using the variables below, create the database tables, then start the server:

```bash
node server.js
```

The server listens on port `4242` unless `PORT` is set. To check the database connection on its own:

```bash
node db-test.js
```

To forward Stripe webhooks during local development, use the [Stripe CLI](https://docs.stripe.com/stripe-cli)
and copy the signing secret it prints into `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:4242/stripe/webhook
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET_CURRENT` | Yes | Signs and verifies auth tokens; the server exits if it is missing |
| `JWT_SECRET_PREVIOUS` | No | Still accepted for verification during secret rotation |
| `JWT_EXPIRES_IN` | No | Token lifetime (default `7d`) |
| `STRIPE_SECRET_KEY` | Yes | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Verifies Stripe webhook signatures |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side Supabase access for receipt storage |
| `PORT` | No | HTTP port (default `4242`) |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | No | Global rate limit (default 120 requests per minute) |
| `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX` | No | Auth rate limit (default 10 requests per minute) |
| `WEBHOOK_RATE_LIMIT_WINDOW_MS`, `WEBHOOK_RATE_LIMIT_MAX` | No | Webhook rate limit (default 300 requests per minute) |
| `METRICS_LOG_INTERVAL_MS` | No | How often metrics are logged (default 60 seconds) |
| `DD_TRACE_ENABLED`, `DD_ENV`, `DD_SERVICE`, `DD_VERSION` | No | Datadog tracing |
| `RESEND_API_KEY`, `FROM_EMAIL` | No | Used by the receipt email helper in `email.js` |

### Database tables

The server creates and updates the `users` table at startup. The other two tables must already
exist, and no migration for them is included in this repo. The server expects these columns:

| Table | Columns |
| --- | --- |
| `donations` | `id`, `amount_cents`, `currency`, `charity_id`, `user_id`, `stripe_payment_intent_id` (unique), `created_at` |
| `receipts` | `id`, `donation_id` (unique), `created_at`, `tax_deductible`, `pdf_url` |

## How a donation works

1. A client calls `POST /create-payment-intent` and completes the payment with the returned
   `client_secret`.
2. Stripe sends `payment_intent.succeeded` to `POST /stripe/webhook`, and the signature is verified.
3. The server saves the donation and a receipt. Duplicate payment intents are ignored.
4. A PDF receipt is generated and uploaded to the `receipts` storage bucket.

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/signup` | Create an account (`email`, `password`, optional `fullName`) and return a token |
| `POST` | `/auth/signin` | Sign in and return a token |
| `POST` | `/create-payment-intent` | Start a donation (`amount` in cents, `charity_id`, optional `currency`, `email`) |
| `POST` | `/stripe/webhook` | Stripe webhook receiver |
| `GET` | `/donations` | List a donor's donations |
| `GET` | `/receipts` | List a donor's receipts |
| `GET` | `/receipts/:id/pdf` | Redirect to a short-lived signed URL for a receipt PDF |
| `GET` | `/tax-summary` | Donation totals per year |
| `GET` | `/tax-summary/:year/pdf` | Generate a PDF tax summary for one year |

Authenticated requests send `Authorization: Bearer <token>`.

## Rotating JWT secrets

```bash
npm run rotate-jwt
```

This updates your local `.env`: the current secret becomes `JWT_SECRET_PREVIOUS` and a new
`JWT_SECRET_CURRENT` is generated. Deploy the new values, and keep the previous secret until
existing tokens expire.

## Project layout

| Path | Purpose |
| --- | --- |
| `server.js` | Express app, routes, auth, and Stripe webhook handling |
| `db.js` | PostgreSQL connection pool |
| `supabase.js` | Supabase client |
| `receiptPdf.js` | Receipt PDF generation |
| `email.js` | Receipt email helper (not currently called by `server.js`) |
| `instrument.js` | Sentry setup |
| `scripts/rotate-jwt-secrets.js` | JWT secret rotation |

## Tests

There is no automated test suite yet; `npm test` is a placeholder that exits with an error.

## License

No license has been specified for this project.
