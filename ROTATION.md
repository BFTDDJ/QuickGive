# Secrets Rotation

This backend should rotate secrets with staged cutover, not blind replacement. The safe sequence is:

1. Generate or create the new secret.
2. Put the new value into DigitalOcean App Platform.
3. Redeploy.
4. Verify the app is healthy.
5. Revoke or remove the old secret only after verification.

Do not keep production secrets in code. Do not rotate provider secrets by editing local `.env` and assuming production is updated.

## JWT

This app supports safe JWT rotation with:

- `JWT_SECRET_CURRENT`
- `JWT_SECRET_PREVIOUS`

### Local helper

Dry run:

```bash
npm run rotate-jwt
```

This prints the exact `JWT_SECRET_CURRENT` and `JWT_SECRET_PREVIOUS` values to place in DigitalOcean.

Optional local `.env` update:

```bash
npm run rotate-jwt:write
```

That only updates your local env file. It does not change production.

### DigitalOcean steps

1. Run `npm run rotate-jwt`.
2. Copy the printed values.
3. In DigitalOcean App Platform:
   - Open your app
   - Go to `Settings` -> `App-Level Environment Variables` or the web service component env vars
   - Set `JWT_SECRET_CURRENT` to the new generated value
   - Set `JWT_SECRET_PREVIOUS` to the old current value
4. Save changes and redeploy.
5. Verify:
   - `GET /health` returns `200`
   - signed-in requests still work
   - new sign-ins also work
6. Wait at least the old token lifetime. In this app that is controlled by `JWT_EXPIRES_IN`.
7. After the old tokens have expired, remove `JWT_SECRET_PREVIOUS` from DigitalOcean and redeploy again.

### Rollback

If auth breaks after deploy:

1. Put the previous production value back into `JWT_SECRET_CURRENT`.
2. Keep the current `JWT_SECRET_PREVIOUS` value or clear it.
3. Redeploy.

## Stripe

### STRIPE_SECRET_KEY

1. Create a new API key in Stripe.
2. In DigitalOcean, replace `STRIPE_SECRET_KEY`.
3. Redeploy.
4. Verify:
   - authenticated `POST /create-payment-intent`
   - live payment creation
5. Revoke the old Stripe key only after those checks pass.

### STRIPE_WEBHOOK_SECRET

1. In Stripe, create a new production webhook endpoint secret or rotate the endpoint.
2. In DigitalOcean, update `STRIPE_WEBHOOK_SECRET`.
3. Redeploy.
4. Send a real or test webhook event to production and verify signature checks pass.
5. Remove the old webhook secret or endpoint.

Do not rotate `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` at the same time unless you need to. It makes rollback harder.

## Supabase

### SUPABASE_SERVICE_ROLE_KEY

1. Generate the replacement service role key in Supabase.
2. In DigitalOcean, replace `SUPABASE_SERVICE_ROLE_KEY`.
3. Confirm `SUPABASE_URL` still matches the same project.
4. Redeploy.
5. Verify:
   - receipt PDF upload works
   - signed receipt URL generation works
6. Revoke the old key.

If you see `Invalid Compact JWS`, the production key is malformed, truncated, from the wrong project, or has leading/trailing whitespace.

## Resend

### RESEND_API_KEY

1. Create a new Resend API key.
2. In DigitalOcean, replace `RESEND_API_KEY`.
3. Redeploy.
4. Trigger:
   - receipt email
   - password reset email
5. Revoke the old key.

## Database password

1. Reset the database password in Supabase.
2. URL-encode the password if it contains reserved URI characters.
3. Update `DATABASE_URL` in DigitalOcean.
4. Redeploy.
5. Verify `GET /health` and `GET /ready` if you add a readiness check.

## Sentry

### SENTRY_DSN

DSNs are less sensitive than secret keys, but still rotate them if exposed or if you want to separate environments.

1. Create the replacement DSN in Sentry.
2. Update `SENTRY_DSN` in DigitalOcean.
3. Redeploy.
4. Trigger a controlled test error and verify it lands in the new project.

## DigitalOcean checklist

For every secret rotation in production:

1. Create the new secret at the provider.
2. Open DigitalOcean App Platform.
3. Edit the environment variable on the backend service.
4. Check carefully for:
   - no quotes
   - no trailing spaces
   - no wrapped lines
   - correct project/account
5. Save and redeploy.
6. Smoke test the affected flow.
7. Revoke the old secret.

## What not to automate yet

Do not set up unattended automatic rotation for:

- Stripe keys
- Supabase service role keys
- Resend keys
- database passwords

Those need coordinated cutover and verification. For this project, only JWT rotation is safely scriptable end-to-end today.
