# Dono Backend API (iOS Reference)

## Base URL
`http://127.0.0.1:4242`

## Auth Headers
- Logged in: `Authorization: Bearer <JWT>`
- Anonymous: `X-Donor-Id: <uuid>` (stable UUID stored on device)

---

## Auth
### POST `/auth/signup`
Body:
```json
{ "email": "user@email.com", "password": "pass1234", "fullName": "Name" }
```
Response:
```json
{ "userId": "uuid", "email": "user@email.com", "token": "jwt" }
```

### POST `/auth/signin`
Body:
```json
{ "email": "user@email.com", "password": "pass1234" }
```
Response:
```json
{ "userId": "uuid", "email": "user@email.com", "token": "jwt" }
```

---

## Payments
### POST `/create-payment-intent`
Headers:
- Logged in: `Authorization: Bearer <JWT>`
- Else: `X-Donor-Id: <uuid>`

Body:
```json
{ "amount": 500, "currency": "usd", "charity_id": "uuid", "email": "optional" }
```
Response:
```json
{ "client_secret": "pi_..._secret_..." }
```

---

## Donations (History)
### GET `/donations`
Headers:
- Logged in: `Authorization: Bearer <JWT>`
- Else: `X-Donor-Id: <uuid>`

Response (array):
```json
{
  "id": "uuid",
  "amount_cents": 500,
  "currency": "usd",
  "charityId": "uuid",
  "donorId": "uuid",
  "paymentIntentId": "pi_...",
  "createdAt": "ISO"
}
```

---

## Receipts
### GET `/receipts`
Headers:
- Logged in: `Authorization: Bearer <JWT>`
- Else: `X-Donor-Id: <uuid>`

Response (array):
```json
{
  "id": "receipt-uuid",
  "donationId": "donation-uuid",
  "amount_cents": 500,
  "currency": "usd",
  "charityId": "charity-uuid",
  "userId": "uuid",
  "paymentIntentId": "pi_...",
  "createdAt": "ISO",
  "taxDeductible": true
}
```

### GET `/receipts/{receiptId}/pdf`
Headers:
- Logged in: `Authorization: Bearer <JWT>`
- Else: `X-Donor-Id: <uuid>`

Returns a 302 redirect to a signed PDF URL.

---

## Tax Summary
### GET `/tax-summary`
Headers:
- Logged in: `Authorization: Bearer <JWT>`
- Else: `X-Donor-Id: <uuid>`

Response (array):
```json
{ "year": 2026, "totalAmount": 50, "deductibleAmount": 50, "donationCount": 3 }
```

### GET `/tax-summary/{year}/pdf`
Headers:
- Logged in: `Authorization: Bearer <JWT>`
- Else: `X-Donor-Id: <uuid>`

Returns inline PDF.
