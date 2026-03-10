# Dono Backend

Node/Express backend for QuickGive/Dono.

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Copy the env template and fill in real values:

```bash
cp .env.example .env
```

3. Start the server:

```bash
npm start
```

## Required environment variables

See `/Users/Deeje/Downloads/DJInnos/dono-backend/.env.example`.

Core production variables:

- `DATABASE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET_CURRENT`
- `RESEND_API_KEY`
- `FROM_EMAIL`
- `FRONTEND_RESET_URL_BASE`

## Health endpoints

- `GET /`
  - basic API status
- `GET /health`
  - process liveness
- `GET /ready`
  - readiness check for env configuration and database connectivity

## Secret rotation

JWT rotation dry run:

```bash
npm run rotate-jwt
```

JWT rotation with local `.env` update:

```bash
npm run rotate-jwt:write
```

Full production rotation instructions are in:

- `/Users/Deeje/Downloads/DJInnos/dono-backend/ROTATION.md`

## Production notes

- Do not commit `.env`.
- Do not commit `node_modules`.
- Rotate any secret that has ever been committed or pasted into logs/chat.
- After changing env vars in DigitalOcean App Platform, redeploy and verify:

```bash
curl -i https://your-production-domain/health
curl -i https://your-production-domain/ready
```
