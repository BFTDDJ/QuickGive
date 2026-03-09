#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <base-url>"
  echo "Example: $0 https://quickgive-dafl8.ondigitalocean.app"
  exit 1
fi

BASE_URL="${1%/}"

echo "==> GET /"
curl -sS -i "${BASE_URL}/"
echo
echo "==> GET /health"
curl -sS -i "${BASE_URL}/health"
echo
