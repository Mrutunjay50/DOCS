# System Architecture — SlashifyTech

## Document Translation & PDF Utility Portal

A consolidated architecture derived from the Product, Frontend, Backend, and Infrastructure plans. This document is the single technical reference for how the system is structured, how data and trust flow through it, and where every responsibility lives.

---

## 1. Architectural overview

SlashifyTech is a **polyglot, three-tier system** built India-first but global-ready (language pairs and currency are configuration, not code). The defining principles:

| Principle | What it means |
|---|---|
| **Single public surface** | The browser only ever talks to the Node gateway. Django is reachable only from the gateway (security-group rule), never publicly. |
| **Async-by-default processing** | Heavy work (OCR, translation, PDF ops) runs on background workers; the UI uploads, gets a `job_id`, polls, downloads. |
| **Encryption at rest + transit** | Files are encrypted at rest by S3 SSE-S3 (AES-256) and travel over TLS. Admins are restricted to metadata by application + JWT-scope policy (no content download route). |
| **Contract-first coordination** | The OpenAPI schema is the source of truth across four developers — generated types keep frontend, gateway, and Django in sync. |
| **One job broker** | RabbitMQ is the single queue for all async work — Node tools (merge, compress, edit, convert) and Django/Celery (OCR, translate, image→PDF). Redis is only cache/sessions/rate-limits. |
| **Infrastructure as code** | Everything is Terraform; no click-ops in production. |

---

## 2. Three-tier topology

```
┌─────────────────────────────────────────────────────────────────────┐
│ TIER 1 · CLIENTS  (Next.js App Router · TypeScript)                   │
│                                                                       │
│   web-b2c  ─────────────┐         web-admin ────────────┐             │
│   consumer app          │         staff dashboard       │             │
│   (mobile-first)        │         (desktop-first)       │             │
│                         └──────────────┬────────────────┘             │
│              access token (user)  │  admin token (aud: admin, TOTP)   │
└────────────────────────────────────┼──────────────────────────────────┘
                                      │  HTTPS — calls ONLY the Node API
                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ TIER 2 · GATEWAY  (Node 20 · Express · Prisma)                        │
│                                                                       │
│   Auth · Accounts · Teams · Billing · PDF tools · Orchestration       │
│   · Notifications · Support · ENTIRE admin backend                    │
│                                                                       │
│   System of record: PostgreSQL 16 (shared w/ admin, elevated creds)   │
│   Async jobs: RabbitMQ (Node consumers)  ·  Cache/sessions: Redis 7   │
└────────────────────────────────────┬──────────────────────────────────┘
                                      │  signed service token
                                      │  (HMAC + short-TTL + X-User-Id/Tier)
                                      ▼   — the ONLY caller of Django
┌─────────────────────────────────────────────────────────────────────┐
│ TIER 3 · PROCESSING  (Django 5 · DRF · Celery)                        │
│                                                                       │
│   OCR · Translation (Hi↔En) · Image→PDF · heavy document work         │
│   Stateless about users; trusts Node's signed token.                  │
│                                                                       │
│   Processing DB: PostgreSQL 16   ·   Broker: RabbitMQ (Celery)        │
│   Storage: S3 (SSE-S3, AES-256 at rest) — reached over TLS            │
└─────────────────────────────────────────────────────────────────────┘
```

### Ownership boundaries

- **Node owns** identity, accounts, teams, money, history, notifications, support, the PDF utility tools (run on its own RabbitMQ worker pool), and the entire admin backend. It is the only thing that calls Django.
- **Django owns** CPU/memory-heavy document processing: OCR, translation, image→PDF — every heavy task on Celery workers, never inline.
- **Two databases:** Node's system-of-record Postgres (shared with admin) and Django's processing Postgres. A Node `JobRef` mirrors the Django `Job` so history/status render without re-querying Django.

---

## 3. Document privacy & lifecycle

Files are encrypted at rest and in transit, kept private from the admin plane by application policy, and deleted at 24h.

```
UPLOAD   client → Node (TLS) → validate JWT + tier → store object in S3
         (SSE-S3, AES-256 at rest) → store metadata + SHA-256 on Job/JobRef

PROCESS  Django worker fetches the object → OCR/translation in memory →
         stores the result in S3 → discards working copy

ADMIN    admin plane has NO content-download route → metadata + SHA-256 only

DELETE   at expires_at (24h): S3 lifecycle rule + Celery-beat sweep delete
         the object and mark the record removed
```

**Privacy controls:**

| Concern | Mechanism |
|---|---|
| At rest | S3 SSE-S3 (AES-256, S3-managed keys); RDS + ElastiCache encryption on |
| In transit | TLS everywhere — ACM on the ALB, internal TLS to Django |
| Admin content lockout | application + JWT-scope policy: the admin module exposes no file-download path; it reads metadata only |
| Retention | 24h S3 lifecycle + Celery-beat sweep |

> **Note on the privacy guarantee.** This is application-enforced, not crypto-enforced. Without KMS envelope encryption + an IAM decrypt split, "admins cannot read documents" holds by policy (no download route, least-privilege IAM on the bucket) rather than by cryptography. If a stronger, provable guarantee is needed later, reintroducing KMS envelope encryption is the upgrade path.

---

## 4. Component breakdown

### Tier 1 — Frontend (monorepo: pnpm + Turborepo)

| Package | Role |
|---|---|
| `apps/web-b2c` | Consumer app — landing, tools, translate, camera scan, PDF editor, dashboard, history, billing, teams, auth. Mobile-first. |
| `apps/web-admin` | Staff dashboard on a shadcn admin template + Tremor charts — users, payments, documents, support, plans, analytics. Desktop-first. |
| `packages/ui` | shadcn/ui component library + design tokens (indigo/violet) shared by both apps. |
| `packages/types` | TypeScript types generated from the gateway's OpenAPI schema. |
| `packages/api-client` | Thin typed fetch client: auth attach, 401→refresh→retry, error-envelope handling — the only thing that touches the network. |

**Frontend foundations (built first):** typed API client, auth/session (access token in memory, refresh in httpOnly cookie), `useJob(jobId)` polling hook (SSE-swappable), reusable uploader, error/toast layer mapping gateway codes (`quota_exceeded`, `file_too_large`, `engine_not_in_tier`) to friendly upsell copy. Data layer is TanStack Query; forms are react-hook-form + zod; i18n in Hindi + English from day one.

### Tier 2 — Node gateway (Express)

Built on **Express 4** with a layered structure (routers → controllers → services → Prisma repositories) and middleware for the cross-cutting concerns. Foundations first: the `ProcessingClient` Django bridge (HMAC signing), an S3 upload layer (objects stored with SSE-S3), a JWT auth middleware that populates org context (`req.user`/`req.tier`/`req.org`), tier policy + config-driven language/currency tables, Redis rate limiting, uniform response/error-envelope middleware, and a RabbitMQ publisher + worker pool (amqplib). Validation via zod; routes grouped into feature modules (folders) so the `/admin/*` tree stays isolated from the public API.

| Module | Responsibility |
|---|---|
| 01 Auth & sessions | argon2id, JWT access (~15m) + rotating refresh, Google OAuth, email verification, password reset, device/session management (Redis denylist) |
| 02 Account & settings | profile/avatar, email-change re-verify, password change, delete (soft-delete + purge + Django file delete), async data export |
| 03 Teams | `Organization` / `Membership` (owner/admin/member) / `Invite`; pooled org quota; org context in JWT |
| 04 Subscriptions & billing | versioned `Plan` with rich entitlements; Razorpay behind a `PaymentProvider` interface; idempotent verification; GST invoices |
| 05 Orchestration & activity | job proxy → store in S3 → Django → `JobRef`; history (cursor paginated); notifications; support intake |
| 06 PDF tools (RabbitMQ workers) | merge (pdf-lib/qpdf), compress (Ghostscript), edit (pdf-lib), DOC→PDF (LibreOffice), PDF→DOC (Django OCR fallback for scans) — all run as queued jobs, never inline |
| 07–10 Admin backend | separate module tree under `/admin/*`: AdminUser + TOTP + IP allowlist; user directory & 360 + impersonation; document oversight + flagging + takedown bridge; read-only billing ops; versioned plan editor; support desk; alert inbox; analytics |

### Tier 3 — Django processing engine (DRF + Celery)

Foundations: shared `Job` model, magic-byte file validation, S3 object fetch (decrypted transparently by SSE-S3), untrusted binaries (LibreOffice/Ghostscript/Tesseract) sandboxed non-root with timeouts, Celery-beat GC past `expires_at`.

| Module | Responsibility |
|---|---|
| 01 OCR / text extraction | Tesseract 5 (`hin`/`eng`) + pre-processing pipeline (grayscale→deskew→denoise→threshold→upscale); premium Google Vision/Textract behind an `OCREngine` adapter; camera perspective-correction |
| 02 Translation | `TranslationEngine` adapter (LibreTranslate free / Google·DeepL premium); chunked long docs; **Devanagari export with Noto Sans embedded** (TXT/DOCX/PDF); sync language auto-detect |
| 03 Image→PDF | `img2pdf` lossless (Pillow fallback); each image → centred A4 page, EXIF honoured |

Adapters mean premium engines are **config, not new endpoints** — adding them never touches the processing path.

---

## 5. Data model (consolidated)

**Node / shared system-of-record DB:**
`User` · `OAuthAccount` · `Session` · `VerificationToken` · `Organization` · `Membership` · `Invite` · `Plan` (versioned, rich entitlements, currency) · `Subscription` (user- or org-scoped) · `Invoice` (GST fields) · `JobRef` (tool, fileName, size, **sha256**, status) · `Notification` · `SupportTicket` · `DataExportRequest` · `AdminUser` · `AdminAlert` · `ReportJob`

**Django processing DB:**
`Job` (UUID, user_id, tier, tool, status, result_file, meta, **sha256**, s3_key, expires_at) · `UploadedFile` · `OCRResult` · `TranslationResult` · `UsageEvent` (billing reconciliation back to Node) · `Language` (config)

---

## 6. Key request flow — a translation job

```
1. web-b2c: user picks source/target lang (config from gateway), uploads file
2. Node: auth middleware validates JWT → tier policy checks entitlements
3. Node: store object in S3 (SSE-S3, encrypted at rest)
4. Node: ProcessingClient (HMAC-signed) → POST Django /api/v1/translate/
         with X-User-Id, X-User-Tier; stores a JobRef (status=queued)
5. Django: service-token auth → enqueues Celery task → returns job id
6. Celery worker: fetch object from S3 → process in memory → OCR if needed
                  → translate → Devanagari-correct export → store result in S3
7. web-b2c: useJob() polls Node GET /api/jobs/{id}; Django completion
            refreshes the cached JobRef status
8. Download: Node proxies a short-lived signed S3 URL — client never reaches Django
9. At 24h: Celery-beat + S3 lifecycle delete the object
```

---

## 7. Infrastructure (AWS, Terraform)

```
Internet → CloudFront (CDN, signed downloads) → ALB (ACM TLS, WAF)
   │
   ├─ ALB-fronted   · EC2 (ASG): web-b2c, web-admin, api-node
   │
   └─ SG-restricted · EC2 (ASG): workers-node, api-django, celery-workers
        (not attached to the ALB — reachable only from api-node's SG)
                            │
        RDS PostgreSQL 16 (node-db SoR + django-db, separate; encrypted)
        Amazon MQ for RabbitMQ (single job broker: Node + Celery)
        ElastiCache Redis (cache, sessions, rate limits; encrypted)
        S3 (uploads/results/exports, SSE-S3, 24h lifecycle)
```

- **Compute:** EC2 Auto Scaling Groups, one per service role (Docker images pulled from ECR, run via the ECS agent in EC2 mode or a systemd/compose unit). No separate private subnet tier — security groups enforce that only `api-node` can reach Django and the data stores, and only public-facing instances are attached to the ALB.
- **Container images:** slim non-root Node/Python bases. The heavy `celery-workers` image bundles tesseract-ocr-hin, poppler, ghostscript, libreoffice, qpdf, **Noto Sans Devanagari**; `workers-node` carries ghostscript/qpdf/libreoffice for Node-side PDF tools.
- **CI/CD:** GitHub Actions, path-filtered per-service pipelines (lint→typecheck→test→build→ECR→staging→smoke→gate→prod). Prisma + Django migrations run as one-off jobs (SSM run-command on a deploy instance) with expand-then-contract. An OpenAPI gate fails the build on contract drift.
- **Observability:** Sentry everywhere; Grafana/Datadog metrics & logs (secrets scrubbed); Flower (Celery) + the RabbitMQ Management UI for live queue/job visibility; immutable audit log for every admin action, impersonation, and takedown.
- **Scaling:** stateless services autoscale on CPU/request; **workers autoscale on queue depth** with priority queues by tier (premium vs free) and heavy LibreOffice/Ghostscript queues capped at low concurrency.
- **DR:** RDS PITR + restore drills; exports bucket versioned; uploads/results intentionally ephemeral (not backed up, by design). Multi-AZ across ≥2 AZs.

---

## 8. Trust & security model

| Boundary | Control |
|---|---|
| Browser → Node | access JWT (user) or admin token (`aud: admin`, never cross-valid); TLS |
| Node → Django | HMAC-signed body + short-TTL timestamp + user headers; DRF auth class rejects unsigned; SG rule allows only `api-node` |
| Admin plane | separate `AdminUser`, mandatory TOTP 2FA, IP allowlist, short hardened sessions, tighter rate limits |
| Document content | encrypted at rest (S3 SSE-S3) + TLS in transit; admin plane has no content-download route (metadata only) |
| Every resource | ownership checks (no IDOR), no account enumeration, idempotent payment verification |
| Compliance | DPDP-aligned: encryption at rest + transit, 24h retention + deletion, data export & deletion flows, metadata-only admin access |

---

## 9. Build sequencing (dependency-ordered)

The order is structured so the **free-tier B2C product works end to end after Step 2/3**; billing, teams, premium engines, and admin layer on top without touching the processing path — only plan entitlements change.

| Step | Node | Django | Frontend | DevOps |
|---|---|---|---|---|
| 0 Foundations | service bridge, auth middleware, Prisma, RabbitMQ pub/worker, rate limit | shared Job, Celery on RabbitMQ, service-token auth, tier policy | shared UI kit, OpenAPI client, app shells | monorepo, CI/CD, SG model, Terraform, worker images |
| 1 Free core | auth, job proxy, history, notifications | OCR + pre-processing | B2C auth, dashboard, translate, history | Tesseract/Poppler image |
| 2 PDF suite | merge/compress/edit/DOC↔PDF | image→PDF (then lend to Node) | tool screens, PDF.js editor, camera | Ghostscript/LibreOffice/Noto image |
| 3 Money | plans, Razorpay, lifecycle, GST | (idle → assist Node) | pricing, checkout, billing | billing observability |
| 4 Teams | orgs, seats, invites, pooled billing | (assist) | team settings | — |
| 5 Premium | — | Vision/Textract + Google/DeepL adapters | (freed for admin) | — |
| 6 Admin | auth boundary → users → docs → billing ops → analytics | absorb admin CRUD | second app on template; dashboard last | absorb admin CRUD glue |
| 7 Hardening | — | — | Playwright E2E flows | load test, security pass, DPDP docs, autoscaling |

**Capacity notes:** the single FE dev is the critical path — the two apps are deliberately sequenced so they're never built at once. Node is second-heaviest; Django's idle stretches (Steps 3–5) are explicitly lent to Node. With no PM, the OpenAPI contract is the coordination tool; with no QA, ~20% of each step is the owning dev's testing plus a DevOps-owned E2E/load harness.
