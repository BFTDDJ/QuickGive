#!/usr/bin/env bash
set -euo pipefail

echo "DigitalOcean production rotation checklist"
echo
echo "1. Create a new secret at the provider."
echo "2. Update the matching env var in DigitalOcean App Platform."
echo "3. Redeploy the backend."
echo "4. Smoke test the affected flow."
echo "5. Revoke the old secret."
echo
echo "Common env vars:"
echo "- JWT_SECRET_CURRENT / JWT_SECRET_PREVIOUS"
echo "- STRIPE_SECRET_KEY"
echo "- STRIPE_WEBHOOK_SECRET"
echo "- SUPABASE_SERVICE_ROLE_KEY"
echo "- DATABASE_URL"
echo "- RESEND_API_KEY"
echo "- SENTRY_DSN"
echo
echo "Use 'npm run rotate-jwt' for a safe JWT cutover plan."
