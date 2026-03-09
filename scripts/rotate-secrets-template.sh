#!/usr/bin/env bash
set -euo pipefail

# This is a template. It does NOT rotate anything by itself.
# Use it as a checklist to update secrets in your hosting provider.

echo "Rotate secrets in your environment (App Platform / CI)."
echo "- STRIPE_SECRET_KEY"
echo "- STRIPE_WEBHOOK_SECRET"
echo "- SUPABASE_SERVICE_ROLE_KEY"
echo "- RESEND_API_KEY"
echo "- SENTRY_DSN"

echo "After updating env vars, restart/redeploy the backend."
