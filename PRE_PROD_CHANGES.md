# Pre-Production Checklist — BE + FE Changes to Support Admin Panel

> This document lists every change that must land in the **main API** and **mobile/web FE** *before production launch* so that the admin panel has the data it needs on day one. Changes are grouped by priority — P0 must ship before launch, P1 should ship at launch, P2 can follow shortly after.

---

## Backend (main API — `memoria-api`)

---

### P0 — Required for Basic Admin Functionality

#### 1. Prisma Schema — New Models

Run a single migration adding all of the following. See `ADMIN_DEVELOPMENT_PLAN.md §4` for full model definitions.

**New models:**

| Model | Purpose |
|---|---|
| `AdminUser` | Stores admin credentials + role |
| `AdminAuditLog` | Every admin action tracked with actor + target |
| `PhotoReport` | Users reporting abusive photos |
| `UserReport` | Users reporting abusive accounts |
| `UserActivityEvent` | Lightweight event log for retention (D1/D7/D30) |

**Fields to add to existing models:**

```prisma
// users table
lastActiveAt          DateTime? @map("last_active_at")
isSuspended           Boolean   @default(false) @map("is_suspended")
suspendedAt           DateTime? @map("suspended_at")
suspensionReason      String?   @map("suspension_reason") @db.VarChar(500)
onboardingCompletedAt DateTime? @map("onboarding_completed_at")

// circle_invites table
acceptedAt   DateTime? @map("accepted_at")
acceptedById String?   @map("accepted_by_id")
```

**Migration checklist:**
- [ ] Write migration file
- [ ] Add DB indexes: `users(last_active_at)`, `users(is_suspended)`, `users(created_at)` (if missing), `user_activity_events(user_id, created_at)`, `photo_reports(status, created_at)`, `user_reports(status, created_at)`
- [ ] Run migration on staging, verify rollback script
- [ ] Run migration on production

---

#### 2. Middleware — Activity Tracking

**File:** `src/middleware/activityTracker.ts` (new file)

Apply after `auth` middleware on all authenticated routes. Does two things:
1. Updates `users.last_active_at = NOW()` (debounced — only write if last update > 5 minutes ago to avoid write amplification)
2. Inserts a `UserActivityEvent` row for specific high-value actions

```typescript
// Pseudo-code — actual implementation is straightforward
export async function trackActivity(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const userId = req.user.id;

  // Debounced lastActiveAt update (use Redis key admin:lastactive:{userId})
  const lastUpdate = await redis.get(`act:la:${userId}`);
  if (!lastUpdate) {
    await prisma.user.update({
      where: { id: userId },
      data: { lastActiveAt: new Date() },
    });
    await redis.setex(`act:la:${userId}`, 300, '1'); // 5-min cooldown
  }

  next(); // non-blocking — don't await heavy work on request path
}
```

**`UserActivityEvent` write points** (add at the end of the relevant controller, after successful response):

| Controller action | eventType |
|---|---|
| POST `/auth/login` (success) | `LOGIN` |
| POST `/memories` (upload complete) | `UPLOAD` |
| POST `/circles` (create) | `CIRCLE_CREATE` |
| POST `/circles/:id/members` (join via invite) | `CIRCLE_JOIN` |
| POST `/events` (create) | `EVENT_CREATE` |
| POST `/ai/chat` (message sent) | `AI_CHAT` |
| AI caption generated | `AI_CAPTION` |

Write activity events **asynchronously** — fire-and-forget, never block the response. Wrap in try/catch so failures are silent.

---

#### 3. Onboarding Completion Tracking

**File:** `src/controllers/v1/onboardingController.ts`

When the user submits their last onboarding answer, set `users.onboarding_completed_at = NOW()`. This enables admin to track onboarding drop-off rates.

```typescript
// After saving answers, check if all required questions answered
const allQuestionsAnswered = /* existing check */;
if (allQuestionsAnswered) {
  await prisma.user.update({
    where: { id: userId },
    data: { onboardingCompletedAt: new Date() },
  });
}
```

---

#### 4. CircleInvite — Acceptance Tracking

**File:** `src/controllers/v1/circleInvite.controller.ts`

When a user accepts an invite link, set `acceptedAt` and `acceptedById` on the `CircleInvite` record. This powers the invite acceptance rate metric in the admin social growth module.

```typescript
// In the accept-invite handler, after adding CircleMember:
await prisma.circleInvite.update({
  where: { id: invite.id },
  data: {
    acceptedAt: new Date(),
    acceptedById: req.user.id,
  },
});
```

---

#### 5. Photo/User Report Endpoints (User-Facing)

Users need a way to report content. Add to the main API:

**File:** `src/routes/v1/reports.ts` (new)

```
POST /api/v1/reports/photos/:photoId   — report a photo
POST /api/v1/reports/users/:userId     — report a user
```

**Request body:**
```json
{ "reason": "string (max 500 chars)" }
```

**Validation rules:**
- Reporter cannot report their own content
- One report per (reporter, target) pair — upsert or return 409 if duplicate
- Photo must exist and not be deleted
- Target user must exist and not be deleted

**Response:** `201 Created` with `{ "reportId": "uuid" }`

All reports land in `PhotoReport` / `UserReport` tables with `status = PENDING`.

---

#### 6. User Suspension — Auth Enforcement

**File:** `src/middleware/auth.ts`

After verifying the JWT, check if the user is suspended. If `isSuspended = true`, return `403 Forbidden` with a clear message.

```typescript
// After decoding JWT and loading user from DB (or add to existing user load)
if (user.isSuspended) {
  return res.status(403).json({
    error: 'ACCOUNT_SUSPENDED',
    message: 'Your account has been suspended. Contact support.',
  });
}
```

> **Note:** The auth middleware currently loads the user from DB (verify this — if it only decodes the JWT without a DB lookup, a DB lookup must be added specifically for the suspension check, or use a Redis denylist approach for better performance).

**Redis denylist alternative** (preferred for performance):
```typescript
// When admin suspends a user, add to Redis:
await redis.set(`suspended:${userId}`, '1');

// In auth middleware (no DB lookup needed):
const suspended = await redis.get(`suspended:${req.user.id}`);
if (suspended) return res.status(403).json({ error: 'ACCOUNT_SUSPENDED' });
```

---

#### 7. Internal Admin Action Endpoints

Add to `src/routes/internal.ts` under `/internal/v1/admin/`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/users/:id/suspend` | Set isSuspended=true, add to Redis denylist |
| POST | `/admin/users/:id/reactivate` | Clear suspension, remove Redis denylist |
| DELETE | `/admin/users/:id` | Trigger existing account deletion flow |
| POST | `/admin/users/:id/storage-grant` | Update mediaStorageCapBytes |
| POST | `/admin/users/reset-ai-limits` | Reset all users' AI quota periods |
| DELETE | `/admin/photos/:id` | Hard-delete photo + R2 cleanup |

These are called by `memoria-admin-api` → `memoria-api` for write operations so that business logic (quota resets, cascade deletes, R2 cleanup, notification sends) lives in one place.

Auth: same `X-Internal-Service-Secret` header used by the AI service.

---

### P1 — Important Before Launch

#### 8. Structured Upload Failure Logging

Currently `Photo.processingError` stores the error string when a photo fails processing. This is sufficient for the admin health module. However, ensure failures are being **consistently set**:

**File:** `src/jobs/` (all job handlers)

Verify every job failure path runs:
```typescript
await prisma.photo.update({
  where: { id: photoId },
  data: {
    status: 'FAILED',
    processingError: error.message.slice(0, 2000),
  },
});
```

This powers the upload failure rate metric without any schema changes.

---

#### 9. AI Caption Failure Tracking

**File:** `src/controllers/internal/captionQuotaInternalController.ts` and the AI caption job

When a caption generation fails (not quota-blocked, but actual AI failure), record it. Options:
- Add `captionFailureCount` to `UserCaptionAiQuota` — simplest
- Or log to `UserActivityEvent` with a new `AI_CAPTION_FAIL` type — more flexible

Recommendation: Add `failedCaptionsToday Int @default(0)` to `UserCaptionAiQuota` and reset with the period. This gives the admin the "failed AI requests today" metric.

---

#### 10. Storage Calculation — Indexed Query Support

The admin storage module needs `SUM(file_size)` grouped by user and globally. The `photos.file_size` column exists. Add a **partial index** to speed up storage queries:

```sql
-- Migration SQL
CREATE INDEX idx_photos_file_size_active
ON photos (user_id, file_size)
WHERE deleted_at IS NULL AND status = 'READY';
```

This makes the `TOP storage users` query fast without a full table scan.

---

#### 11. Notification — Account Warning

When an admin warns a user from the moderation queue, a push notification should be sent. Add a notification type:

**File:** `src/events/notification.events.ts`

```typescript
// New notification type
'ADMIN_WARNING': {
  title: 'Account Warning',
  body: 'Your content was removed for violating community guidelines.',
}
```

The admin API will call the main API's internal endpoint to trigger this.

---

### P2 — Can Follow Shortly After Launch

#### 12. API Latency Tracking (App Health)

Add a response-time middleware that logs slow requests (>2 seconds) to a `SlowRequestLog` table or to structured logs. For MVP, structured logs are sufficient — the admin health panel can read from log aggregation (Datadog, Logtail, etc.) rather than a DB table.

If no log aggregation is set up yet, a minimal approach:
```typescript
// In src/middleware/responseTime.ts
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms > 2000) {
      console.error(JSON.stringify({
        type: 'SLOW_REQUEST',
        method: req.method,
        path: req.path,
        ms,
        status: res.statusCode,
      }));
    }
  });
  next();
});
```

---

#### 13. Crash/Error Rate

For the admin health panel's crash rate metric, integrate a proper error tracking service:

**Recommended:** Sentry (free tier is sufficient for MVP)

```typescript
// src/server.ts — after route registration
import * as Sentry from '@sentry/node';
Sentry.setupExpressErrorHandler(app);
```

The admin panel's "crash rate" card can display the Sentry error count via Sentry API or just link out to the Sentry dashboard. This is simpler than building a custom error logging table.

---

## Frontend (Mobile App)

---

### P0 — Required Before Launch

#### F1. Suspension Error Handling

The app must handle the new `403 ACCOUNT_SUSPENDED` response gracefully.

**What to do:**
- In your global API error interceptor (Axios interceptor or fetch wrapper), detect `error.code === 'ACCOUNT_SUSPENDED'`
- Log the user out and navigate to a dedicated "Account Suspended" screen
- Show a clear message: *"Your account has been suspended. Please contact support."*
- Do NOT retry the request or loop — just clear session and show the screen

---

#### F2. Report Photo / Report User UI

Users need a way to flag content so that admin moderation has data to work with.

**Report Photo:**
- Add a "Report" option to the photo action sheet (long-press or `...` menu)
- Opens a bottom sheet with reason options: `Inappropriate content`, `Spam`, `Harassment`, `Other`
- Calls `POST /api/v1/reports/photos/:photoId`
- Show success toast: *"Report submitted. We'll review it shortly."*
- Disable the report button after submission (one report per user per photo)

**Report User:**
- Add a "Report" option to user profile screens
- Same reason options + free-text for "Other"
- Calls `POST /api/v1/reports/users/:userId`

---

#### F3. Storage Limit Exceeded Handling

If a user hits their storage cap, the API returns a `413` or storage-specific error. Make sure the app:
- Shows a clear message: *"You've reached your storage limit."*
- Does not silently fail the upload
- Ideally surfaces a nudge toward the storage settings screen

---

#### F4. AI Quota Exceeded — Clear Messaging

The quota exceeded response already exists. Verify the app shows distinct messages for:
- Chat quota exceeded vs Caption quota exceeded
- Daily limit vs lifetime limit
- These messages should tell the user when their quota resets (the API returns `resetsAt`)

---

### P1 — Important Before Launch

#### F5. Onboarding Step Completion Signal

For the admin onboarding drop-off metric to be accurate, the FE must complete the full onboarding flow and call the final answer submission endpoint. Verify:
- Every onboarding screen's "Next" button calls `POST /api/v1/onboarding/answers`
- The final step submits the last answer (which triggers `onboardingCompletedAt` on the BE)
- There is no path to skip onboarding silently without the last answer being submitted

---

#### F6. Upload Failure User Feedback

When a photo upload fails (the worker sets `status = FAILED`), the app needs to surface this:
- The app should poll or use push notifications to detect failed uploads
- Show a retry option: *"Some photos failed to upload. Tap to retry."*
- Log the failure event on the device for support debugging

Currently, if the app doesn't poll `GET /memories` for FAILED status photos, the user never knows the upload silently failed. This also affects the admin upload failure rate accuracy.

---

#### F7. Device Platform Reporting on FCM Token Registration

When registering FCM tokens, the `platform` field on `FcmDeviceToken` should be set (`ios` or `android`). This helps admin filter push notification data by platform.

**File:** wherever the FCM token is registered (likely in app startup or notification permission grant)

```typescript
// Ensure platform is sent
await api.post('/notifications/register-token', {
  token: fcmToken,
  platform: Platform.OS, // 'ios' or 'android'
});
```

---

### P2 — Can Follow Shortly After Launch

#### F8. In-App Admin Warning Notification

When an admin warns a user, a push notification will be sent with type `ADMIN_WARNING`. The app should:
- Display it as a system-style notification (different styling than social notifications)
- Navigate to a neutral screen when tapped (not to the removed content, which no longer exists)
- Consider showing a dismissable in-app banner as well

---

## Summary — What to Build in Order

### Sprint 1 (Before any admin work starts)
1. **BE:** Prisma migration — add all new models + fields
2. **BE:** Activity tracking middleware + write `UserActivityEvent` at key controller points
3. **BE:** CircleInvite acceptance tracking
4. **BE:** Onboarding completion tracking
5. **FE:** Suspension error handling screen

### Sprint 2 (Enables core admin modules)
1. **BE:** Photo/user report endpoints + validation
2. **BE:** Internal admin action endpoints (suspend, delete, storage grant)
3. **BE:** Redis suspension denylist in auth middleware
4. **FE:** Report photo + report user UI

### Sprint 3 (Enables analytics modules)
1. **BE:** Storage index migration
2. **BE:** AI caption failure counter
3. **BE:** Verify all job failure paths set `Photo.processingError`
4. **FE:** Upload failure feedback + retry UI
5. **FE:** Onboarding completion verification

### Sprint 4 (Polish)
1. **BE:** Sentry integration for crash rate
2. **BE:** Response time middleware + slow request logging
3. **BE:** Admin warning notification type
4. **FE:** Admin warning push notification handling
5. **FE:** Platform field on FCM token registration
