# Core Asana Partners — API

Backend for **Core Asana Partners**, a first version of an affiliate program for Core Asana. Yoga teachers, physiotherapists, studios and wellness creators recommend the products with a personal code. Their students get 10% off, the partner earns 12%, and partners are paid every Friday.

It is one of three repositories:

| Repo | What it is |
| --- | --- |
| **coreasana-partners-api** (this one) | Node.js + Express + MongoDB. Orders, commissions, payouts, auth. |
| [coreasana-partners-app](https://github.com/TarunVermaaa/coreasana-partners-app) | React Native (Expo) app for partners. Join, share a code, track earnings and payouts. Ships as an APK. |
| [coreasana-partners-dashboard](https://github.com/TarunVermaaa/coreasana-partners-dashboard) | React web dashboard for the affiliate team and finance. Review and release commissions, run payouts. |

## Try it live

| | |
| --- | --- |
| Dashboard (affiliate team and finance) | https://coreasana-partners-dashboard.onrender.com |
| Partner app (Android APK) | [Download from the latest release](https://github.com/TarunVermaaa/coreasana-partners-app/releases/latest) |
| API | https://coreasana-partners-api.onrender.com/api/v1/health |

Demo logins use the password `Demo@1234`: `ops@partners.demo`, `finance@partners.demo`, `admin@partners.demo` (dashboard) and `priya@partners.demo` (app). The servers are on Render's free plan, so the first request after a quiet spell can take about a minute while the API wakes up.

**Walkthrough of the happy path (5 minutes):** [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md), or watch the [3-minute video tutorial](https://github.com/TarunVermaaa/coreasana-partners-app/releases/download/v1.0.0/core-asana-partners-tutorial.mp4).

---

## What v1 does, and why

The brief names three problems. v1 is the smallest product that addresses each one end to end, so a partner's sale can be followed all the way to money in their bank account.

| Problem | What v1 does |
| --- | --- |
| **Get more people to sign up** | The app shows the terms and an earnings calculator **before** asking for anything. Signup takes about a minute. The partner **picks a code they can say out loud in class** (PRIYA10), with a live availability check and suggestions. The code works immediately; ops can pause an account later. Bank details are asked for only once there is money to pay. |
| **Affiliate team can't track and release commissions reliably** | Every order becomes a commission that moves through one state machine: **on hold → ready → in payout → paid**, or **reversed** or **rejected**. Each commission carries its full history. Commissions are released automatically when the 15-day return window ends. Risky orders wait for a person instead: self-referrals, unusually large orders, and the same shopper reusing a code. Refunds reverse the commission, or claw it back from the next payout if it was already paid. |
| **Finance struggles to make payments** | A weekly payout run. The preview shows who will be paid, and **why everyone else won't be** (no payout details, below the ₹500 minimum, paused, or a clawback larger than the balance). TDS is deducted under s.194H. One click creates the batch and a **bank bulk-upload CSV**. Finance records each transfer's **UTR**, or marks it failed with the bank's reason; failed money goes back to the partner's balance automatically. |

What v1 deliberately leaves out is listed in [What's next](#whats-next).

---

## Run it locally

Requirements: Node 20+ and Docker (for MongoDB). An Atlas connection string works instead of Docker.

```bash
docker compose up -d          # MongoDB 7 as a single-node replica set (needed for transactions)
cp .env.example .env          # defaults work locally
npm ci
npm run dev                   # http://localhost:4100 — seeds 60 days of demo data on first start
```

Health check: `curl localhost:4100/api/v1/health` returns `{"status":"ok","db":"up"}`.

| Command | What it does |
| --- | --- |
| `npm run dev` | API with reload |
| `npm test` | 34 tests against an in-memory MongoDB replica set (no Docker needed) |
| `npm run seed -- --reset` | Wipe the database and reseed the demo data |
| `npm run simulate:order -- PRIYA10` | Act as the store: send a signed order webhook (`--qty 2`, `--refund <orderId>`) |
| `npm run build && npm start` | Production build |

### Demo accounts (password `Demo@1234` for all)

| Who | Email | What to look at |
| --- | --- | --- |
| Admin | `admin@partners.demo` | Everything, plus settings and the "simulate order" tool |
| Affiliate team (ops) | `ops@partners.demo` | 3 commissions need review: a self-referral, a ₹21,520 studio order, a repeat shopper |
| Finance | `finance@partners.demo` | Last Friday's batch is half reconciled: one transfer bounced, two still need their UTR |
| Partner | `priya@partners.demo` | Yoga teacher in Gurugram, code PRIYA10, two months of history |
| Partner | `kabir@partners.demo` | Has earnings but no payout details yet, so finance sees him as blocked |

---

## How the three repos talk to each other

```
  Partner's phone                    Core Asana store (Laravel)
  ┌──────────────┐                   ┌───────────────────────┐
  │ partners-app │──── REST ───┐     │ checkout with a code  │
  └──────────────┘             ▼     └──────────┬────────────┘
                        ┌──────────────┐        │ signed webhook
                        │ partners-api │◀───────┘ POST /api/v1/webhooks/orders
  ┌──────────────────┐  │ Express 5    │
  │ partners-        │──│ MongoDB      │◀── GET /r/PRIYA10 (share link: count the click,
  │ dashboard (web)  │  └──────────────┘        then 302 to coreasana.com/?ref=PRIYA10)
  └──────────────────┘
```

**Startup order:**
1. MongoDB
2. this API
3. the dashboard and the app, in any order

The clients only need the API's base URL:

| Client | Variable | Local value |
| --- | --- | --- |
| Dashboard | `VITE_API_URL` | `http://localhost:4100` |
| App | `EXPO_PUBLIC_API_URL` (build time). The URL can also be changed in the app: long-press the logo on the welcome screen. | `http://<your-LAN-IP>:4100` on a phone; `http://10.0.2.2:4100` on the Android emulator |

The API's own variables are documented in [`.env.example`](.env.example).
- `CORS_ORIGINS` must include the dashboard's URL.
- `PUBLIC_API_URL` is used to build partners' share links.

---

## Architecture

```
src/
  config/env.ts        environment, validated with Zod at startup (fails fast with a readable message)
  models/              Mongoose schemas: Affiliate, Staff, Order, Commission, Payout, Activity, Settings, ClickDay
  services/            business rules; routes stay thin
    attribution.ts       order and refund ingestion, risk flags, commission calculation
    commissions.ts       the state machine: moveCommissions(), release job, review
    payouts.ts           preview, batch creation, UTR / failure handling, bank file
    affiliates.ts        signup, codes, payout details, partner summary
    admin.ts             dashboard aggregates (pipeline, overview, partners)
  routes/              public, /me (partner), /admin (staff), /webhooks, /r (share links)
  middleware/          JWT auth + roles, Zod validation, error handler
  jobs/release.ts      release job with a lease lock (safe with several instances)
  seed/                demo data, generated by replaying events through the services
test/                  Vitest + supertest + mongodb-memory-server
```

### Key decisions

- **Money is integer paise; rates are basis points.** ₹322.81 is stored as `32281` and 12% as `1200`. Summing thousands of small commissions never drifts, and rounding happens in exactly one place (`applyBps`).
- **One state machine for commissions.**
  - `TRANSITIONS` in [`models/commission.ts`](src/models/commission.ts) lists every legal move.
  - [`moveCommissions()`](src/services/commissions.ts) is the only code that changes a status. Its update matches only documents still in the expected state, so two people (or a person and the release job) can never double-apply a change. The second one simply matches nothing.
- **Each commission embeds its history.** "Why hasn't this been paid?" is answered by one document. A separate `activities` collection keeps the audit log of who did what across the program.
- **Idempotent order ingestion.** The store's order id is the idempotency key, and a unique partial index allows only one `sale` commission per order. Redelivered or concurrent webhooks can't double-count; there is a test that fires three at once. Refunds send the cumulative refunded amount, so replays are harmless too.
- **Transactions where money moves.**
  - Creating a batch writes the payout and moves every commission it pays to `in_payout` in one MongoDB transaction. If any commission changed meanwhile, the whole batch rolls back, so a commission can't be paid twice. Tested with two simultaneous batch requests.
  - Recording a UTR or a failure is also transactional.
- **Separation of duties.** The affiliate team (`ops`) approves and rejects commissions. Finance creates and settles payouts. Neither can do the other's job; `admin` can do both.
- **Commission is calculated on product value after the partner discount, excluding shipping and GST.** Rate, discount, hold days, minimum payout and TDS rates live in a settings document. Changing them affects new orders only; each commission keeps the rate it was earned at.
- **Risk flags, not silent rules.**
  - A self-referral, an order above ₹15,000, or a shopper using the same code four times in 30 days is held for review with a plain-language reason. It is never auto-released.
  - Shoppers are stored only as keyed hashes (HMAC) of their email and phone, enough to detect these patterns without keeping customer contact details.
- **Payout PII is encrypted at rest.**
  - Bank account numbers and PAN are encrypted with AES-256-GCM (`PII_ENCRYPTION_KEY`).
  - The API only ever returns the last 4 digits.
  - The only place they are decrypted is the bank file finance downloads, and that download is logged.
- **TDS (s.194H):** 2% with a PAN on file, 20% without; both are configurable. The app nudges partners to add a PAN.
- **Webhooks are verified** with an HMAC-SHA256 signature of the raw body, compared in constant time.
- **Auth:**
  - Bearer JWTs for both clients: the native app can't rely on cookies, and one scheme keeps the API simple.
  - Partners stay signed in for 30 days; staff sessions last 12 hours.
  - Login, signup and code checks are rate limited.
- **Errors have one shape:** `{ "error": { "code", "message", "details": [{ "field", "message" }] } }`. Forms can show every field problem at once.
- **Dates are Indian time.** "Payouts every Friday" and daily stats use IST, wherever the server runs.

---

## API reference

Base URL `/api/v1`. JSON. Authenticated routes need `Authorization: Bearer <token>`. Money is in paise.

### Public and partner auth
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{ status, db }` |
| GET | `/program` | Commission %, discount %, hold days, minimum payout, next payout date, average order value, TDS rates |
| GET | `/codes/:code/availability` | `{ code, available, reason?, suggestions[] }` |
| POST | `/auth/affiliate/signup` | `{ name, email, phone, password, audience, code, city?, instagram? }` → 201 `{ token, affiliate }` |
| POST | `/auth/affiliate/login` | `{ email, password }` → `{ token, affiliate }` |
| POST | `/auth/staff/login` | `{ email, password }` → `{ token, staff }` |

### Partner (`affiliate` role, always scoped to the caller)
| Method | Path | Notes |
| --- | --- | --- |
| GET / PATCH | `/me` | Profile |
| PUT | `/me/payout-method` | `{ type: 'upi', upiId, pan? }` or `{ type: 'bank', accountName, accountNumber, ifsc, pan? }` |
| GET | `/me/summary` | Balances by status, next payout estimate and blockers, 30-day clicks/orders/earnings, share URL, recent commissions |
| GET | `/me/commissions?status=&limit=&cursor=` | Cursor-paginated, with order details and history |
| GET | `/me/payouts` | Only the partner's own payment in each batch |

### Staff (`ops`, `finance`, `admin`)
| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/admin/overview` | all | Pipeline totals, 30-day series, top partners, next payout |
| GET | `/admin/affiliates?search=&status=` | all | Partners with orders, sales, earned, ready |
| GET / PATCH | `/admin/affiliates/:id` | all / ops | Detail; pause or reactivate |
| GET | `/admin/commissions?view=needs_review\|on_hold\|due\|ready\|in_payout\|paid\|reversed\|all` | all | With totals for the view |
| POST | `/admin/commissions/review` | ops | `{ ids[], decision: approve\|reject, note? }`. A note is required to reject or to approve early |
| POST | `/admin/commissions/release-due` | ops | Release now instead of waiting for the job |
| GET | `/admin/payouts/preview` | finance | Eligible partners (gross, TDS, net) and blocked ones with reasons |
| POST | `/admin/payouts` | finance | `{ affiliateIds[] }` → 201 batch |
| GET | `/admin/payouts`, `/admin/payouts/:id` | all | Batches and their payments |
| GET | `/admin/payouts/:id/bank-file` | finance | CSV for the bank's bulk upload |
| POST | `/admin/payouts/:id/items/:itemId/paid` | finance | `{ utr }` |
| POST | `/admin/payouts/:id/items/:itemId/failed` | finance | `{ reason }` |
| GET | `/admin/activity?entityId=&entity=&before=` | all | Audit log |
| GET / PATCH | `/admin/settings` | all / admin | Program terms |
| POST | `/admin/demo/orders`, `/admin/demo/refund` | ops | Demo only (`DEMO_TOOLS=true`). Uses the same code path as the webhook |

### Store webhook
`POST /api/v1/webhooks/orders`, header `X-CoreAsana-Signature: sha256=<hex HMAC-SHA256 of the raw body with WEBHOOK_SECRET>`.

```jsonc
{ "event": "order.created",
  "order": { "id": "CA-48311", "placedAt": "2026-10-21T10:15:00+05:30", "code": "PRIYA10",
             "customer": { "email": "shopper@example.com" },
             "items": [{ "sku": "ACU-PRO-LAV", "name": "AcuTech Mat Pro", "qty": 1, "price": 298900 }],
             "subtotal": 298900, "discount": 29890, "shipping": 0, "tax": 0, "total": 269010 } }

{ "event": "order.refunded", "order": { "id": "CA-48311", "refundedAmount": 269010 } }   // cumulative
```

Every understood event gets a 200: `created`, `duplicate`, `applied`, or `ignored` with a reason. The store therefore never retries forever. Bad signatures get 401 and malformed payloads get 400. [`scripts/simulate-order.ts`](scripts/simulate-order.ts) is a working example of a sender.

The Laravel side needs two things:
- On order creation and refund, POST these events when an order used a partner code.
- On landing, read `?ref=CODE` and pre-apply that partner's 10% discount.

---

## Tests

`npm test` runs 34 tests on a throwaway in-memory MongoDB replica set. They cover:
- webhook signatures and idempotency, including concurrent duplicates
- the 12% calculation and the hold period
- self-referral and high-value flags
- refunds: reversed, reduced, clawed back
- payout eligibility and TDS
- batch locking, including two simultaneous batch requests
- UTR and failure handling
- the bank file, including spreadsheet-formula injection
- review rules
- role separation and partner data isolation
- signup validation and conflicts, code suggestions, payout-detail validation and masking, share links

## Deployment

[`render.yaml`](render.yaml) is a Render Blueprint for the API. MongoDB runs on a free Atlas cluster, which is a replica set, so transactions work.

1. Create an Atlas cluster and copy its `mongodb+srv://…` URI.
2. In Render: New → Blueprint → this repo. Fill in:
   - `MONGODB_URI`
   - `PII_ENCRYPTION_KEY` (`openssl rand -hex 32`)
   - `PUBLIC_API_URL` (the service's own URL)
   - `CORS_ORIGINS` (the dashboard's URL)
3. On first boot it seeds the demo data. Set `SEED_ON_BOOT=false` and `DEMO_TOOLS=false` for a real launch.

## Trade-offs and limitations

- **Instant approval of new partners.** This is the right call for signup growth; the trade-off is that fraud is handled afterwards (flags, review, pause). With volume, the next step is a light approval queue for partners without a social profile.
- **Attribution is by code, last touch.** Teachers mostly share codes verbally, and the store already handles coupon codes. Link clicks are counted, but a cookie-based attribution window would need store-side work.
- **The release job runs inside the API process.** A lease lock keeps it safe with several instances. A dedicated worker queue would be the next step at scale.
- **Payouts are bank-file based.** Finance uploads the CSV to the bank, then records UTRs. That matches how most Indian finance teams work today. A RazorpayX or Cashfree Payouts integration would replace both steps; see below.
- **Simplified TDS.** It is flat per payout. It doesn't track the annual s.194H threshold or issue Form 16A.
- **Embedded payout items.** Fine up to a few thousand partners per batch, then the items move to their own collection.

## What's next

1. **Pay out through RazorpayX / Cashfree Payouts.** Create transfers from the batch, take UTRs and failures from their webhooks, and verify bank details by penny-drop when partners add them.
2. **Notifications.** Push and WhatsApp messages for "you made a sale", "your money is ready" and "paid, UTR …". This drives partners' activity more than anything else.
3. **Partner referrals.** "Invite another teacher" with a bonus on their first sale, which is a direct lever on signups.
4. **Tiers and campaigns.** A higher rate above monthly sales thresholds; time-boxed boosts for launches.
5. **Store integration on the Laravel side,** plus a reconciliation report that matches store orders and refunds against commissions daily.
6. **Compliance.** Annual TDS thresholds, Form 16A, GST invoicing for partners who are businesses (studios).
