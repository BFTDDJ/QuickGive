# Secrets Rotation Checklist

This project expects secrets to live in environment variables (never in code). Use this checklist when rotating secrets.

## JWT
- Use `npm run rotate-jwt` to rotate `JWT_SECRET_CURRENT` and set `JWT_SECRET_PREVIOUS`.
- Deploy with both secrets for the token TTL window.
- Remove `JWT_SECRET_PREVIOUS` after old tokens expire.

## Stripe
### STRIPE_SECRET_KEY
1. Create a new restricted key in Stripe.
2. Update `STRIPE_SECRET_KEY` in your environment.
3. Deploy.
4. Revoke the old key.

### STRIPE_WEBHOOK_SECRET
1. Create a new webhook endpoint in Stripe (or rotate secret if supported).
2. Update `STRIPE_WEBHOOK_SECRET` in your environment.
3. Deploy.
4. Delete the old webhook endpoint or old secret.

## Supabase
### SUPABASE_SERVICE_ROLE_KEY
1. Generate a new Service Role key in Supabase.
2. Update `SUPABASE_SERVICE_ROLE_KEY` in your environment.
3. Deploy.
4. Revoke the old key.

## Resend
### RESEND_API_KEY
1. Generate a new API key in Resend.
2. Update `RESEND_API_KEY` in your environment.
3. Deploy.
4. Revoke the old key.

## Sentry
### SENTRY_DSN
1. Create a new DSN if needed (optional).
2. Update `SENTRY_DSN` in your environment.
3. Deploy.
4. Revoke the old DSN.

## Notes
- Rotate secrets after any suspected exposure.
- Keep old secrets valid only as long as needed for a seamless cutover.
- Use your hosting provider’s env var management (DigitalOcean App Platform recommended).
