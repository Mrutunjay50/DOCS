# Memoria Admin Panel — Development Plan

> **Scope:** Admin panel as a standalone microservice (`memoria-admin-api`) backed by the same PostgreSQL database as the main API. The admin frontend is a separate web app (React/Next.js recommended).

---

## 1. Architecture Overview

```
┌─────────────────────────┐        ┌──────────────────────────┐
│   Admin Web App (FE)    │ HTTPS  │  memoria-admin-api       │
│   React / Next.js       │───────▶│  Node + Express + Prisma │
│   Port: 3001 (dev)      │        │  Port: 4001              │
└─────────────────────────┘        └──────────┬───────────────┘
                                              │
                        ┌─────────────────────┼──────────────────────┐
                        │                     │                      │
               ┌────────▼───────┐   ┌─────────▼──────┐   ┌─────────▼──────┐
               │  PostgreSQL DB │   │  Redis Cache   │   │ Main API       │
               │  (shared, R/W) │   │  (shared)      │   │ (internal calls│
               └────────────────┘   └────────────────┘   │  for actions)  │
                                                          └────────────────┘
```

### Key Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| DB access | Direct Prisma to shared DB | Faster to build, no API proxy overhead for reads |
| Write operations | Call main API `/internal/v1/admin/*` endpoints | Keeps business logic (quota resets, cascade deletes) in one place |
| Auth | Separate `AdminUser` model + JWT with `adminId` claim | Never share user tokens with admin surface |
| Cache | Same Redis, separate key prefix `admin:` | Expensive aggregation queries cached 5–60 min |
| Deployment | Independent Docker container | Deploy/scale without touching main API |
| Database writes that are purely admin (suspend, audit log) | Direct Prisma writes | Simpler, no round-trip needed |

---

## 2. Tech Stack

```
Runtime:     Node.js 20 LTS + TypeScript 5
Framework:   Express 4
ORM:         Prisma 5 (same schema, shared DB)
Cache:       Redis (ioredis) — key prefix admin:
Auth:        JWT (jsonwebtoken) — separate admin secret
Validation:  Zod
Security:    helmet, express-rate-limit, bcrypt
Logging:     morgan + structured JSON logs
```

---

## 3. Project Structure

```
memoria-admin-api/
├── prisma/
│   └── schema.prisma          # Symlink or copy of main schema + admin models
├── src/
│   ├── config/
│   │   ├── database.ts        # Prisma client
│   │   ├── redis.ts           # Redis client (shared instance)
│   │   └── env.ts             # Zod env validation
│   ├── middleware/
│   │   ├── adminAuth.ts       # JWT verification (admin claims only)
│   │   ├── rateLimiter.ts     # Per-IP + per-admin rate limiting
│   │   └── error.ts           # Global error handler
│   ├── modules/
│   │   ├── auth/              # Admin login, refresh, session
│   │   ├── dashboard/         # Top metrics, 7-day graphs, health indicators
│   │   ├── users/             # User listing, detail, admin actions
│   │   ├── circles/           # Circle listing, detail, admin actions
│   │   ├── events/            # Event listing, detail
│   │   ├── moderation/        # Reported photos + reported users
│   │   ├── storage/           # Storage metrics + alerts
│   │   ├── ai-usage/          # AI quota tracking + top users
│   │   ├── retention/         # D1/D7/D30, repeat uploaders
│   │   ├── social/            # Invite tracking, social growth
│   │   └── health/            # Crash rate, upload failures, API latency
│   ├── services/
│   │   ├── metricsCache.ts    # Redis-backed aggregation cache
│   │   └── mainApiClient.ts   # Axios client for main API internal calls
│   └── server.ts
├── Dockerfile
└── package.json
```

---

## 4. Database — New Models Required

These models must be added to the **main** Prisma schema before the admin service can function. See `PRE_PRODUCTION_CHECKLIST.md` for the full migration plan.

### 4.1 AdminUser
```prisma
model AdminUser {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String    @map("password_hash")
  name         String
  role         AdminRole @default(VIEWER)
  lastLoginAt  DateTime? @map("last_login_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  auditLogs    AdminAuditLog[]

  @@map("admin_users")
}

enum AdminRole {
  SUPER_ADMIN
  ADMIN
  VIEWER
}
```

### 4.2 AdminAuditLog
```prisma
model AdminAuditLog {
  id          String   @id @default(uuid())
  adminId     String   @map("admin_id")
  action      String                       // e.g. SUSPEND_USER, DELETE_PHOTO
  targetType  String   @map("target_type") // USER | CIRCLE | PHOTO | EVENT
  targetId    String   @map("target_id")
  metadata    Json?                        // extra context (reason, old value, etc.)
  createdAt   DateTime @default(now()) @map("created_at")

  admin AdminUser @relation(fields: [adminId], references: [id])

  @@index([adminId])
  @@index([targetType, targetId])
  @@index([createdAt])
  @@map("admin_audit_logs")
}
```

### 4.3 PhotoReport
```prisma
model PhotoReport {
  id           String             @id @default(uuid())
  photoId      String             @map("photo_id")
  reportedById String             @map("reported_by_id")
  reason       String             @db.VarChar(500)
  status       ReportStatus       @default(PENDING)
  reviewedAt   DateTime?          @map("reviewed_at")
  createdAt    DateTime           @default(now()) @map("created_at")

  photo      Photo @relation(fields: [photoId], references: [id], onDelete: Cascade)
  reportedBy User  @relation(fields: [reportedById], references: [id], onDelete: Cascade)

  @@index([status, createdAt])
  @@index([photoId])
  @@map("photo_reports")
}
```

### 4.4 UserReport
```prisma
model UserReport {
  id             String       @id @default(uuid())
  targetUserId   String       @map("target_user_id")
  reportedById   String       @map("reported_by_id")
  reason         String       @db.VarChar(500)
  status         ReportStatus @default(PENDING)
  reviewedAt     DateTime?    @map("reviewed_at")
  createdAt      DateTime     @default(now()) @map("created_at")

  targetUser User @relation("UserReportTarget", fields: [targetUserId], references: [id], onDelete: Cascade)
  reportedBy User @relation("UserReportReporter", fields: [reportedById], references: [id], onDelete: Cascade)

  @@index([status, createdAt])
  @@index([targetUserId])
  @@map("user_reports")
}

enum ReportStatus {
  PENDING
  REVIEWED
  DISMISSED
  ACTION_TAKEN
}
```

### 4.5 UserActivityEvent (for Retention)
```prisma
model UserActivityEvent {
  id        String            @id @default(uuid())
  userId    String            @map("user_id")
  eventType UserActivityType  @map("event_type")
  createdAt DateTime          @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@index([eventType, createdAt])
  @@map("user_activity_events")
}

enum UserActivityType {
  LOGIN
  UPLOAD
  CIRCLE_CREATE
  CIRCLE_JOIN
  EVENT_CREATE
  AI_CHAT
  AI_CAPTION
}
```

### 4.6 Fields to add to existing models

```prisma
// User model additions
model User {
  // ... existing fields ...
  lastActiveAt     DateTime? @map("last_active_at")   // updated by middleware
  isSuspended      Boolean   @default(false) @map("is_suspended")
  suspendedAt      DateTime? @map("suspended_at")
  suspensionReason String?   @map("suspension_reason") @db.VarChar(500)
  onboardingCompletedAt DateTime? @map("onboarding_completed_at")
}

// CircleInvite additions
model CircleInvite {
  // ... existing fields ...
  acceptedAt   DateTime? @map("accepted_at")
  acceptedById String?   @map("accepted_by_id")  // userId who accepted
}
```

---

## 5. API Modules — Endpoints

All routes prefixed `/api/v1/admin/`. Protected by `adminAuth` middleware except auth routes.

### 5.1 Auth Module

| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | Admin email + password login, returns JWT pair |
| POST | `/auth/refresh` | Refresh access token |
| POST | `/auth/logout` | Invalidate refresh token |
| GET | `/auth/me` | Current admin session info |

**JWT payload:** `{ adminId, email, role, iat, exp }`
**Access token TTL:** 15 min | **Refresh token TTL:** 7 days

---

### 5.2 Dashboard Module

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard/metrics` | All top metric cards (signups, DAU, uploads, etc.) |
| GET | `/dashboard/graphs` | 7-day graph data (signups, circles, uploads) |
| GET | `/dashboard/health-indicators` | Positive + negative indicator counts |

**`GET /dashboard/metrics` response:**
```json
{
  "signupsToday": { "value": 42, "previousDay": 38, "changePercent": 10.5 },
  "activeUsersToday": { "value": 210, "previousDay": 195, "changePercent": 7.7 },
  "circlesCreatedToday": { "value": 18, "previousDay": 22, "changePercent": -18.2 },
  "photosUploadedToday": { "value": 540, "previousDay": 480, "changePercent": 12.5 },
  "eventsCreatedToday": { "value": 31, "previousDay": 28, "changePercent": 10.7 },
  "totalStorageUsedGb": 127.4,
  "aiPromptsUsedToday": 89,
  "uploadFailureRatePercent": 1.2
}
```

**Query strategy for metrics** (examples):
```sql
-- New signups today
SELECT COUNT(*) FROM users
WHERE created_at >= CURRENT_DATE AND deleted_at IS NULL;

-- Active users today (needs lastActiveAt)
SELECT COUNT(DISTINCT user_id) FROM user_activity_events
WHERE created_at >= CURRENT_DATE;

-- Upload failures today
SELECT
  COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
  COUNT(*) AS total
FROM photos WHERE created_at >= CURRENT_DATE;
```

**Cache TTL:** 5 minutes for metric cards, 15 minutes for graph data.

---

### 5.3 Users Module

| Method | Path | Description |
|---|---|---|
| GET | `/users` | Paginated user list with search + filters |
| GET | `/users/:id` | User detail page |
| POST | `/users/:id/suspend` | Suspend user account |
| POST | `/users/:id/reactivate` | Reactivate suspended user |
| DELETE | `/users/:id` | Permanently delete user |
| POST | `/users/:id/storage-grant` | Grant additional storage (bytes) |
| POST | `/users/reset-ai-limits` | Reset AI usage for all users |

**`GET /users` query params:**
```
search=    (name, username, email)
status=    active | suspended
sort=      joined_desc | joined_asc | most_active | high_storage
page=      (default 1)
limit=     (default 20, max 100)
```

**`GET /users` response row:**
```json
{
  "id": "uuid",
  "name": "Jane Doe",
  "username": "janedoe",
  "email": "jane@example.com",
  "joinedAt": "2024-01-15T10:00:00Z",
  "lastActiveAt": "2026-05-22T18:45:00Z",
  "storageUsedBytes": 524288000,
  "totalCirclesCreated": 4,
  "uploadCount": 87,
  "aiUsageCount": 23,
  "isSuspended": false
}
```

**`GET /users/:id` response** includes the row above plus:
- `joinedCircles[]` — circle name, memberCount, joinedAt
- `createdEvents[]` — event name, circle name, uploadCount
- `recentActivity[]` — last 5 `UserActivityEvent` records
- `storageBreakdown` — photos count + bytes
- `aiStats` — periodTokens, lifetimeTokens per domain
- `reports[]` — reports filed against this user

**Admin actions all write to `AdminAuditLog`.**

---

### 5.4 Circles Module

| Method | Path | Description |
|---|---|---|
| GET | `/circles` | Paginated circle list |
| GET | `/circles/analytics` | Aggregate circle health stats |
| GET | `/circles/:id` | Circle detail |
| DELETE | `/circles/:id` | Delete circle |
| POST | `/circles/:id/archive` | Soft-archive circle (sets deletedAt) |
| DELETE | `/circles/:id/members/:userId` | Remove member |
| DELETE | `/circles/:id/photos/:photoId` | Remove abusive photo |

**`GET /circles` query params:**
```
search=     (circle name, creator name)
status=     active | empty | archived
sort=       recent | most_uploads | most_members
page=, limit=
```

**`GET /circles/analytics` response:**
```json
{
  "totalCircles": 1240,
  "activeCircles": 980,
  "emptyCircles": 143,
  "circlesWithMultipleContributors": 612,
  "multiContributorPercent": 62.4,
  "avgUploadsPerCircle": 34.2,
  "avgMembersPerCircle": 5.1
}
```

---

### 5.5 Events Module

| Method | Path | Description |
|---|---|---|
| GET | `/events` | Paginated event list |
| GET | `/events/analytics` | Event aggregate stats |
| GET | `/events/:id` | Event detail |
| DELETE | `/events/:id/photos/:photoId` | Remove photo from event |

**`GET /events` query params:** `search`, `status=active|no_uploads`, `circleId`, `page`, `limit`

---

### 5.6 Moderation Module

| Method | Path | Description |
|---|---|---|
| GET | `/moderation/photo-reports` | Paginated reported photos |
| GET | `/moderation/user-reports` | Paginated reported users |
| POST | `/moderation/photo-reports/:id/delete-photo` | Delete reported photo |
| POST | `/moderation/photo-reports/:id/dismiss` | Dismiss report |
| POST | `/moderation/photo-reports/:id/warn-user` | Warn uploader (sends notification) |
| POST | `/moderation/user-reports/:id/suspend` | Suspend reported user |
| POST | `/moderation/user-reports/:id/delete-account` | Delete reported user account |
| POST | `/moderation/user-reports/:id/dismiss` | Dismiss report |

**`GET /moderation/photo-reports` response row:**
```json
{
  "reportId": "uuid",
  "photoId": "uuid",
  "photoThumbnailUrl": "https://...",
  "uploaderId": "uuid",
  "uploaderName": "John Smith",
  "reason": "Inappropriate content",
  "reportedAt": "2026-05-21T14:30:00Z",
  "status": "PENDING"
}
```

---

### 5.7 Storage Module

| Method | Path | Description |
|---|---|---|
| GET | `/storage/metrics` | Platform-wide storage overview |
| GET | `/storage/top-users` | Top 20 users by storage |
| GET | `/storage/top-circles` | Top 20 circles by upload size |
| GET | `/storage/daily-growth` | Daily upload bytes for last 30 days |

**`GET /storage/metrics` response:**
```json
{
  "totalStorageUsedGb": 127.4,
  "dailyUploadSizeGb": 2.3,
  "avgStoragePerUserMb": 48.2,
  "uploadFailurePercent": 1.2,
  "storageAlertLevel": "OK"
}
```

`storageAlertLevel`: `"OK"` | `"WARNING"` (>80%) | `"CRITICAL"` (>90%)

---

### 5.8 AI Usage Module

| Method | Path | Description |
|---|---|---|
| GET | `/ai-usage/metrics` | Platform AI usage summary |
| GET | `/ai-usage/top-users` | Top 20 users by AI usage today |
| GET | `/ai-usage/daily-trend` | Daily AI prompt counts for last 30 days |
| GET | `/ai-usage/near-limit` | Users nearing daily chat/caption limits |

**`GET /ai-usage/metrics` response:**
```json
{
  "promptsUsedToday": 89,
  "captionsGeneratedToday": 203,
  "failedAiRequestsToday": 4,
  "usersNearChatLimit": 7,
  "usersNearCaptionLimit": 12
}
```

---

### 5.9 Retention Module

| Method | Path | Description |
|---|---|---|
| GET | `/retention/metrics` | D1/D7/D30 rates + repeat usage |
| GET | `/retention/cohorts` | Weekly cohort breakdown |

**`GET /retention/metrics` response:**
```json
{
  "d1RetentionPercent": 68.4,
  "d7RetentionPercent": 41.2,
  "d30RetentionPercent": 22.7,
  "repeatUploaderPercent": 54.1,
  "repeatCircleCreatorPercent": 31.8,
  "weeklyReturningUsers": 1240,
  "circlesWithMultipleContributorsPercent": 62.4
}
```

**D1 Retention query logic:**
```sql
-- Users who signed up 1 day ago AND had activity today (D1)
SELECT
  COUNT(DISTINCT uae.user_id)::float /
  NULLIF(COUNT(DISTINCT u.id), 0) * 100 AS d1_rate
FROM users u
LEFT JOIN user_activity_events uae
  ON uae.user_id = u.id
  AND uae.created_at >= u.created_at + INTERVAL '1 day'
  AND uae.created_at < u.created_at + INTERVAL '2 days'
WHERE u.created_at >= CURRENT_DATE - INTERVAL '2 days'
  AND u.created_at < CURRENT_DATE - INTERVAL '1 day'
  AND u.deleted_at IS NULL;
```

---

### 5.10 Social Growth Module

| Method | Path | Description |
|---|---|---|
| GET | `/social/metrics` | Invite + social growth stats |
| GET | `/social/invite-trend` | Daily invite sends + accepts last 30 days |

**`GET /social/metrics` response:**
```json
{
  "totalInvitesSent": 3420,
  "inviteAcceptancePercent": 47.3,
  "avgInvitesPerUser": 2.8,
  "circlesWithTwoOrMoreMembers": 890,
  "circlesWithTwoOrMoreMembersPercent": 71.8
}
```

---

### 5.11 App Health Module

| Method | Path | Description |
|---|---|---|
| GET | `/health/metrics` | Platform health summary |
| GET | `/health/upload-failures` | Upload failure breakdown last 7 days |
| GET | `/health/ai-failures` | AI processing failure counts |

**`GET /health/metrics` response:**
```json
{
  "uploadFailureRatePercent": 1.2,
  "imageProcessingFailureCount": 8,
  "failedEmbeddingsCount": 12,
  "aiProcessingFailures": 4,
  "status": "HEALTHY"
}
```

`status`: `"HEALTHY"` | `"DEGRADED"` | `"CRITICAL"`

**Derived from existing `Photo` model:**
```sql
-- Upload failures (processing errors in last 24h)
SELECT COUNT(*) FROM photos
WHERE status = 'FAILED'
  AND created_at >= NOW() - INTERVAL '24 hours';

-- Embedding failures
SELECT COUNT(*) FROM photos
WHERE embedding_status = 'failed'
  AND created_at >= NOW() - INTERVAL '24 hours';
```

---

## 6. Admin Authentication

### Flow
1. Admin logs in with email + password → receives `accessToken` (15 min) + `refreshToken` (7 days, stored in HttpOnly cookie)
2. All admin API requests send `Authorization: Bearer <accessToken>`
3. `adminAuth` middleware verifies token, checks `AdminUser.isSuspended` (future), attaches `req.admin`
4. Refresh token endpoint issues a new access token

### Rate limiting
- Login endpoint: 5 attempts per 15 minutes per IP
- All other endpoints: 100 requests per minute per admin

### Password policy
- bcrypt with cost factor 12
- Minimum 12 characters

---

## 7. Caching Strategy

| Data | Cache Key | TTL |
|---|---|---|
| Dashboard metric cards | `admin:metrics:daily` | 5 min |
| 7-day graph data | `admin:graphs:7d` | 15 min |
| Storage metrics | `admin:storage:metrics` | 10 min |
| Top storage users | `admin:storage:top-users` | 30 min |
| Retention metrics | `admin:retention:metrics` | 60 min |
| AI usage today | `admin:ai:metrics:daily` | 5 min |
| Circle analytics | `admin:circles:analytics` | 15 min |

Cache is invalidated on relevant admin write actions (e.g. deleting a user invalidates `admin:metrics:daily`).

---

## 8. Development Phases

### Phase 1 — Foundation (Week 1–2)
- [ ] Set up `memoria-admin-api` repo/package
- [ ] Prisma client connected to shared DB
- [ ] Admin auth module (login, refresh, JWT middleware)
- [ ] `AdminUser` seed script (create first super-admin)
- [ ] `AdminAuditLog` write helper

### Phase 2 — Core Read Modules (Week 3–4)
- [ ] Dashboard metrics + graphs
- [ ] Users listing + detail page
- [ ] Circles listing + analytics
- [ ] Events listing + analytics

### Phase 3 — Admin Actions (Week 5)
- [ ] User suspend / reactivate / delete
- [ ] Circle delete / archive / remove member
- [ ] Remove abusive photos (circles, events)
- [ ] Storage grant for user

### Phase 4 — Moderation (Week 6)
- [ ] Photo reports listing + actions
- [ ] User reports listing + actions
- [ ] User warning notification via main API

### Phase 5 — Analytics Modules (Week 7–8)
- [ ] Storage module
- [ ] AI usage module
- [ ] Retention module (D1/D7/D30)
- [ ] Social growth module
- [ ] App health module

### Phase 6 — Admin Frontend (Week 9–12, parallel)
- [ ] Dashboard page
- [ ] Users management page
- [ ] Circles management page
- [ ] Events page
- [ ] Moderation queue
- [ ] Storage + AI + Retention + Health pages

---

## 9. Admin Frontend — Tech Recommendation

| Concern | Recommendation |
|---|---|
| Framework | Next.js 14 (App Router) |
| UI Components | shadcn/ui + Tailwind CSS |
| Charts | Recharts or Chart.js |
| Data fetching | TanStack Query (React Query) |
| Auth state | HttpOnly cookie for refresh token + in-memory access token |
| Table | TanStack Table for sortable/filterable lists |

---

## 10. Environment Variables (Admin Service)

```env
DATABASE_URL=                    # Same as main API
REDIS_URL=                       # Same as main API
ADMIN_JWT_SECRET=                # Separate secret — never share with main API
ADMIN_JWT_REFRESH_SECRET=        # Separate refresh secret
MAIN_API_INTERNAL_URL=           # http://memoria-api:4000/internal/v1
MAIN_API_INTERNAL_SECRET=        # Same as AI_INTERNAL_SECRET in main API
PORT=4001
NODE_ENV=production
BCRYPT_COST_FACTOR=12
```

---

## 11. Security Checklist

- [ ] Admin endpoints unreachable from public internet (internal VPC or IP allowlist)
- [ ] All admin actions logged to `AdminAuditLog`
- [ ] Rate limiting on login (brute-force protection)
- [ ] Passwords hashed with bcrypt cost 12
- [ ] Refresh token stored in HttpOnly, Secure, SameSite=Strict cookie
- [ ] CORS restricted to admin frontend origin only
- [ ] Helmet middleware for security headers
- [ ] Input validated with Zod on all endpoints
- [ ] Admin service has read + limited write access only (no DROP, no schema changes)
