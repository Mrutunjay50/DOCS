# SOP — Node Developer (A–Z)
## Document Translation & PDF Utility Portal — SlashifyTech

This is the working manual for the **Node.js / Express gateway** developer. It covers everything from environment setup to the day-to-day rules, the build order, and the definition of done. Read it once end-to-end, then use it as a reference.

> **Your one-line mandate:** Node is the **system of record** and the **only public API**. Every browser request is authenticated, metered, and (if heavy) queued by you, then proxied to Django over a signed private channel. You own identity, accounts, teams, money, history, notifications, support, the PDF tools, and the entire admin backend.

---

## A. Scope & responsibilities

**You own:**
- Auth & sessions, accounts & settings, teams/orgs, billing, orchestration, notifications, support.
- The PDF utility tools (merge, compress, edit, DOC↔PDF) — run as **queued RabbitMQ jobs**, never inline.
- The entire admin backend under `/admin/*`.
- The **Django bridge** (`ProcessingClient`) — the only code in the system allowed to call Django.

**You do NOT own:**
- OCR / translation / image→PDF internals → that's the Django dev. You call them through the bridge.
- Frontend rendering → FE dev. You serve them a clean, typed contract.
- Infra/Terraform/EC2/RabbitMQ provisioning → DevOps. You consume what they stand up.

**Hard rules (never violate):**
1. The browser never reaches Django — only your gateway does, via the signed bridge.
2. Heavy work is **always** queued (RabbitMQ). Request handlers stay fast.
3. Every resource access is **ownership-checked** (no IDOR).
4. The **OpenAPI contract is the source of truth** — keep it current or the FE/types desync.
5. The admin module has **no document-content download route** (metadata only).

---

## B. Prerequisites & local environment

Install:
- **Node 20 LTS** (use `nvm`/`fnm`; pin via `.nvmrc`).
- **pnpm** (the monorepo uses pnpm + Turborepo).
- **Docker Desktop** (for the local stack).
- **PostgreSQL client** (`psql`) for inspection.

Local stack via `docker-compose` (owned by DevOps, you run it):
```bash
docker compose up -d        # Postgres ×2, Redis, RabbitMQ, MinIO (S3 stand-in)
```
This gives you: `node-db` + `django-db` (Postgres 16), Redis (cache/sessions/rate-limits), **RabbitMQ** (job broker, management UI on :15672), and **MinIO** as the S3 stand-in with server-side encryption.

`.env` (never commit; copy from `.env.example`):
```
DATABASE_URL=postgresql://...node-db
JWT_ACCESS_SECRET=...           JWT_REFRESH_SECRET=...
RABBITMQ_URL=amqp://...         REDIS_URL=redis://...
S3_ENDPOINT=http://localhost:9000  S3_BUCKET_UPLOADS=...  S3_BUCKET_RESULTS=...
DJANGO_BASE_URL=http://localhost:8000
SERVICE_BRIDGE_HMAC_SECRET=...  # shared with Django
RAZORPAY_KEY_ID=...  RAZORPAY_KEY_SECRET=...
```
Secrets in real environments come from **AWS Secrets Manager / SSM**, never `.env` files in the repo.

---

## C. Monorepo layout (what you touch)

```
apps/
  api-node/          ← YOUR app (Express gateway)
  workers-node/      ← YOUR worker process (RabbitMQ consumers: PDF tools, email, exports)
  web-b2c/ web-admin/ ← FE dev
packages/
  types/             ← OpenAPI-generated TS types (shared; you generate the schema)
  api-client/        ← FE dev consumes; generated from your OpenAPI
api-django/          ← Django dev
```

**Inside `apps/api-node/` (layered):**
```
src/
  modules/
    auth/  account/  teams/  billing/  orchestration/  support/  notifications/
    admin/        ← separate router tree, hardened
  middleware/     ← auth, tier-policy, rate-limit, error-envelope, request-id
  lib/
    processing-client.ts   ← the Django bridge (HMAC)
    s3.ts                  ← upload/download, SSE-S3
    queue.ts               ← RabbitMQ publisher (amqplib)
    prisma.ts              ← Prisma client singleton
  config/         ← env validation (zod), constants
  openapi/        ← spec assembly + generation
  app.ts  server.ts
prisma/
  schema.prisma   migrations/
```
Each module is a folder: `*.router.ts` → `*.controller.ts` → `*.service.ts` → Prisma. Routers wire middleware; controllers validate (zod) + shape responses; services hold logic; only services touch Prisma.

---

## D. Tech stack & non-negotiable conventions

| Concern | Choice |
|---|---|
| Runtime / framework | Node 20 + **Express 4** + TypeScript (strict) |
| ORM | **Prisma** + PostgreSQL 16 |
| Validation | **zod** on every request body/query/params; env validated at boot |
| Auth | **JWT** access (~15 min) + rotating refresh (hashed in `Session`); argon2id for passwords; admin = `aud: admin` + TOTP |
| Job broker | **RabbitMQ** (amqplib) — all async work; one broker system-wide |
| Cache/sessions/rate-limit | **Redis 7** only (not a job broker) |
| Object storage | **S3** with **SSE-S3** (AES-256); presigned URLs for download; no KMS |
| Payments | Razorpay behind a `PaymentProvider` interface (Stripe-swappable) |
| Contract | **drf-spectacular/OpenAPI** → generated Node client + FE types |
| Lint/format | ESLint + Prettier (CI-enforced) |
| Tests | Jest (unit/integration), Testcontainers (real Postgres+Redis), nock/msw (bridge contract) |

**Response envelope (uniform, always):**
```ts
{ data }                      // success (single)
{ data, page }                // success (paginated, cursor-based)
{ error: { code, message } }  // failure — never leak stack traces
```
Error codes are a shared enum (e.g. `quota_exceeded`, `file_too_large`, `engine_not_in_tier`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`). FE maps these to copy — coordinate names via the contract.

---

## E. Foundations — build these FIRST (block everything)

Build in this order before any feature module:

1. **Config + env validation** (`config/`) — zod-parse all env at boot; fail fast.
2. **Prisma client singleton** (`lib/prisma.ts`) + initial schema + first migration.
3. **Error-envelope middleware** — central error handler; maps thrown `AppError(code, message, status)` to the envelope; scrubs secrets.
4. **Request context + auth middleware** — validate access JWT, load `req.user` + active subscription + **org context** (`req.org`, `req.tier`). Public routes explicitly allow-listed. Admin routes require `aud: admin`.
5. **Tier policy** — entitlements from the `Plan` table; helper `assertEntitlement(tier, key)`; Django re-checks too (defence in depth).
6. **Rate limiting** — Redis token-bucket per user & per IP; tighter on `/auth/*` and `/billing/*`.
7. **S3 layer** (`lib/s3.ts`) — `putObject` (SSE-S3), `getSignedDownloadUrl` (short TTL).
8. **RabbitMQ** (`lib/queue.ts`) — connection, `publish(queue, payload)`, durable queues, dead-letter queue for poison messages.
9. **The Django bridge** (`lib/processing-client.ts`) — see section F.
10. **OpenAPI assembly + generation** wired into the build (see section L).

Only after these compile and have tests do you start feature modules.

---

## F. The Django bridge (`ProcessingClient`) — critical

Every call to Django goes through this one class. Nothing else in Node may import the Django URL.

- **Signing:** HMAC the request body with `SERVICE_BRIDGE_HMAC_SECRET` + a short-TTL timestamp; send as a header. Django's custom DRF auth class rejects anything unsigned or stale.
- **Headers:** attach `X-User-Id` and `X-User-Tier` so Django can re-check tier.
- **Resilience:** sane timeouts, bounded retries (idempotent calls only), circuit-break on repeated failure. On Django downtime, surface a clean `503 engine_unavailable` — never hang the request.
- **Surface:** `submitOcr`, `submitTranslate`, `detectLanguage`, `submitImagesToPdf`, `getJob`, `getJobResult`, `takedown(jobId)`.
- **Contract test it** with nock/msw: signing header present + correct, user headers attached, error mapping (Django `4xx/5xx` → your error codes).

---

## G. Orchestration & the job lifecycle (the heart of the gateway)

The canonical flow for any processing job:

```
POST /api/tools/{slug}
  → auth middleware (req.user, req.tier)
  → zod-validate body + file (type by magic bytes, size by tier)
  → tier policy: assertEntitlement
  → s3.putObject(upload)                       # SSE-S3
  → ProcessingClient.submitX(...)              # signed bridge → Django enqueues Celery
  → persist JobRef { djangoJobId, tool, fileName, size, sha256, status: queued, ownerId }
  → respond { data: { jobId } }                # fast; no waiting
```

- **Polling:** `GET /api/jobs/{id}` returns cached `JobRef` status (ownership-checked). Django's completion webhook refreshes the cached status. Designed so an SSE upgrade is a drop-in later.
- **Download:** `GET /api/jobs/{id}/download` → mint a **short-lived signed S3 URL** and 302. The client never reaches Django.
- **History:** cursor pagination; filter (tool/status/date); search; Today/This-week/Earlier buckets; bulk delete (records + tell Django to delete files).

---

## H. PDF tools as queued jobs (Node workers)

All PDF tools run in `apps/workers-node` as **RabbitMQ consumers**, never inline:

```
POST /api/pdf/merge  → validate + tier check → s3.putObject(inputs)
  → publish("pdf.merge", { jobId, s3Keys, options, ownerId })
  → persist JobRef (status: queued) → respond { jobId }

worker-node consumes "pdf.merge"
  → fetch inputs from S3 → run tool (pdf-lib / Ghoststript / qpdf / LibreOffice)
  → store result in S3 → update JobRef (status: done) → notify
```

Tool notes:
- **Merge** — pdf-lib; client-supplied order; encrypted-input support via qpdf; enforce tier batch/size limits.
- **Compress** — Ghostscript subprocess; presets + target-MB mode; hard timeout; non-root, temp dir.
- **Edit** — apply a normalised operations list with pdf-lib (coords in PDF points).
- **DOC→PDF** — LibreOffice headless; Noto Sans Devanagari in the worker image; dedicated **low-concurrency** queue.
- **PDF→DOC** — LibreOffice for text PDFs; **scanned/no-text-layer PDFs proxy to Django OCR first** (the one PDF tool that calls the bridge).

Always: sandbox untrusted binaries, non-root user, temp working dir, hard timeouts, memory caps.

---

## I. Module build order (matches the program plan)

Build features in this dependency order; each unlocks the next:

1. **Auth & sessions** — signup/login (argon2id), JWT access + rotating refresh (hashed in `Session`), Google OAuth + account linking, email verification gate, password reset (single-use, time-boxed, hashed tokens; no enumeration; reset revokes all sessions), session/device management (revoke via Redis denylist).
2. **Orchestration + history + notifications** — section G. Free-tier core works end to end after this.
3. **PDF tools** — section H.
4. **Account & settings** — profile/avatar (presigned upload + sharp resize), email-change re-verify, password change (revokes other sessions), delete account (re-auth + type-to-confirm; cancels sub; soft-delete + delayed purge that also tells Django to delete files; invoices retained anonymised), data export (async RabbitMQ job → zip → S3 signed link).
5. **Billing** — `Plan` (versioned, rich entitlements, currency), Razorpay behind `PaymentProvider`, **server-side idempotent payment verification before activating**, cancel-at-period-end, dunning, GST invoices (`gstin, placeOfSupply, cgst, sgst, igst, hsnSac, taxableValue, total`) rendered server-side.
6. **Teams** — `Organization`/`Membership`(owner|admin|member)/`Invite`; seat limits; **pooled quota** (usage counted at org level); org context in JWT; role guard on org routes.
7. **Admin backend** (`/admin/*`) — separate router tree, hardened (see section J).

---

## J. Admin backend rules (`/admin/*`)

A separate, hardened router tree sharing the DB with elevated credentials.

- **Identity:** `AdminUser` (separate from `User`), argon2id, **mandatory TOTP 2FA**, `aud: admin` short token + rotating refresh, **IP allowlist**, lockout. A user token can never reach `/admin/*` and vice versa.
- **People & docs:** cursor-paginated user directory (filters, quota/spend read models, CSV export); user-360 aggregation; **time-boxed flagged impersonation** (`scope: support`, logged on mint + per action); suspend/reinstate (status + session revoke + job block + notify); **document oversight** = JobRef metadata + SHA-256 + Flagged status; **takedown** purges the file via the bridge — **content never enters the admin backend**.
- **Billing ops (read-only):** ledger + revenue tiles, subscription oversight reconciled vs provider, invoice/revenue reports as async `ReportJob`s.
- **Platform ops:** versioned plan/entitlement editor (the exact numbers Django enforces — no drift); support desk; alert inbox (`AdminAlert`); analytics (cached aggregates + live queue depth).

**Audit everything:** every admin action, impersonation mint/use, and takedown is logged immutably.

---

## K. Database & Prisma workflow

- Schema lives in `prisma/schema.prisma`. Core models: `User, OAuthAccount, Session, VerificationToken, Organization, Membership, Invite, Plan, Subscription, Invoice, JobRef, Notification, SupportTicket, DataExportRequest, AdminUser, AdminAlert, ReportJob`.
- **Migrations:** `pnpm prisma migrate dev` locally; never edit a shipped migration. In staging/prod, migrations run as **one-off SSM jobs** (DevOps) using **expand-then-contract** for zero downtime.
- Use transactions for multi-write invariants (e.g. accept-invite + decrement seat).
- Index what you filter/paginate on (cursor fields, `ownerId`, `status`, `createdAt`).
- `JobRef.djangoJobId` mirrors the Django `Job` — that's a logical link across two DBs, not an FK.

---

## L. The OpenAPI contract (your coordination tool)

There is no PM — the contract keeps four developers in sync.

- Define/annotate every endpoint's request + response schema as you build it.
- On every gateway change: **regenerate** `packages/types` and the FE `api-client`. CI has an **OpenAPI gate** that fails the build if the contract and consumers drift.
- Treat a contract change like an API change: communicate it, version if breaking.

---

## M. Security checklist (apply to every endpoint)

- [ ] **Ownership check** on every resource (no IDOR) — filter by `req.user.id`/`req.org.id`, never trust a path id alone.
- [ ] **zod validation** on body, query, params; reject unknown fields.
- [ ] **Tier policy** enforced before doing work; Django re-checks.
- [ ] **Rate limit** appropriate to the route (tighter on auth/payments/public forms; captcha on public support form).
- [ ] **No account enumeration** (login, forgot-password, signup return uniform responses/timing).
- [ ] **Idempotent payment verification** (idempotency key; verify server-side before activating).
- [ ] **Secrets scrubbed** from logs; never log tokens, card data, file contents.
- [ ] **Admin routes**: `aud: admin`, TOTP, IP allowlist, no decrypt/download path.
- [ ] File uploads: validate **magic bytes** + size **by tier** before storing.

---

## N. Testing standards

Weight testing on **auth, money, the staff boundary, and document safety**.

- **Unit:** services + guards + pure helpers.
- **Integration:** endpoints against real test Postgres + Redis via **Testcontainers**.
- **Bridge contract:** nock/msw — signing, headers, error mapping.
- **Always test:** idempotent payment verification; no-IDOR on every resource; no account enumeration; that the admin module exposes **no document-content download route**; pooled-quota decrements across org members; seat limits on invite/accept.
- Mock all paid providers (Razorpay/Google/DeepL) in CI; keep one gated live test each.
- Target: ~20% of every feature's effort is your own tests (no dedicated QA). You also write Playwright flows for your surface (DevOps maintains the harness).

---

## O. Git & PR workflow

- Branch per task: `feat/auth-refresh-rotation`, `fix/billing-idempotency`.
- Conventional commits; small, reviewable PRs.
- PR must: pass lint + typecheck + tests + the OpenAPI gate; include tests; update the contract; note any migration.
- Never commit secrets or `.env`. Never skip CI hooks.
- Migrations: expand-then-contract; never destructive without a backfill plan.

---

## P. Observability & ops hooks

- **Structured JSON logs** with a request id; secrets scrubbed.
- **Sentry** wired in `api-node` and `workers-node`.
- Emit metrics for: request latency, error rates, **queue depth**, worker throughput, payment success/failure.
- Watch the **RabbitMQ Management UI** (queue backlog, dead-letter queue) and **Flower** (Celery) when debugging cross-service jobs.

---

## Q. Definition of Done (per feature)

A feature is done when:
1. Endpoints implemented with zod validation + the uniform envelope.
2. Ownership + tier + rate-limit checks in place.
3. Heavy work is queued (not inline); workers idempotent + bounded.
4. Prisma migration written (expand-then-contract) and applied.
5. OpenAPI updated; `types` + `api-client` regenerated; gate green.
6. Unit + integration tests pass; security checklist (section M) walked.
7. Logs/metrics emitted; errors mapped to known codes.
8. PR reviewed and merged; contract change communicated to FE/Django.

---

## R. Quick reference — endpoints you own

```
# Public (access token required except auth)
POST /auth/signup /login /refresh /logout /google
POST /auth/verify-email /forgot-password /reset-password
GET  /auth/sessions          DELETE /auth/sessions/{id}
GET  /account   PATCH /account /account/email /account/password
DELETE /account              POST /account/export   GET /account/export
POST /orgs   GET /orgs/{id}   POST /orgs/{id}/invites
POST /orgs/invites/{token}/accept
PATCH/DELETE /orgs/{id}/members/{userId}
GET  /billing/plans /billing/summary /billing/invoices
POST /billing/checkout       POST /billing/subscription/cancel
POST /api/tools/{slug}       GET /api/jobs/{id} /api/jobs/{id}/download
GET  /history                POST /history/bulk-delete
GET  /notifications          POST /notifications/read
POST /support/tickets
POST /api/pdf/merge /compress /edit
POST /api/convert/doc-to-pdf /pdf-to-doc

# Admin (aud: admin, 2FA, IP-allowlisted)
POST /admin/auth/login /2fa /refresh /logout
GET  /admin/users /admin/users/export
GET/POST /admin/users/{id} /{id}/impersonate
POST /admin/users/{id}/suspend /reinstate
GET/POST /admin/documents /{id}/takedown
GET  /admin/payments /{id} /metrics/revenue
GET  /admin/subscriptions
GET/POST /admin/invoices /reports/revenue /reports/export
GET/PATCH/POST /admin/plans /{id} /{id}/publish
GET/POST/PATCH /admin/tickets /{id} /{id}/reply
GET/POST /admin/alerts /alerts/read
GET  /admin/dashboard /metrics/{series}
```

---

*Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) (system design), [ARCHITECTURE-DIAGRAMS.md](ARCHITECTURE-DIAGRAMS.md) (visuals), [02-Backend-Development-Plan.md](02-Backend-Development-Plan.md) (module specs).*
