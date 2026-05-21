# Memoria — Security Plan

---

## 1. Database Access Security (OpenVPN)

### Current State
Database is accessible via connection string in `.env`. Anyone with the string can connect directly.

### Plan
All direct database access (debugging, migrations, admin queries) must go through a private VPN tunnel. The database server will only accept connections from the VPN IP — not the open internet.

### How It Works
```
Developer/Admin
      │
      ▼
 OpenVPN / WireGuard Server  ←── only entry point to DB network
      │
      ▼
 PostgreSQL (private IP, no public exposure)
```

### Setup (Future)
- Provision a small VPS (DigitalOcean/AWS) as VPN server
- Use **WireGuard** (simpler, faster than OpenVPN) or OpenVPN Access Server
- Restrict PostgreSQL `pg_hba.conf` to only allow connections from VPN subnet
- Each team member gets a unique VPN config/key — revocable individually
- DB connection string in production uses private IP, not public

### Cost
| Item | Cost |
|---|---|
| VPN server (DigitalOcean Droplet 1GB) | $6-$10/month |
| WireGuard | Free |
| OpenVPN Access Server (up to 2 users) | Free |
| Setup time | 4-6 hours |

### Pre-release alternative (right now)
- Restrict DB to allowlisted IPs only (your server IP + your home/office IP)
- Most managed DB providers (Supabase, Railway, Neon) support this in dashboard — **do this before launch, costs nothing**

---

## 2. Signed URL Security (Memoria App Only)

### Current State
Presigned R2 URLs are time-limited but accessible by anyone who has the URL — no app-level restriction.

### Goal
Only requests originating from the Memoria mobile app should be able to use signed URLs.

### Options

#### Option A — Cloudflare Worker Proxy (Recommended)
Instead of giving the app a direct R2 presigned URL, route all media requests through a Cloudflare Worker that:
- Validates a short-lived app token in the request header (`X-Memoria-Token`)
- Checks the token against Redis (issued at login, tied to userId)
- Forwards to R2 only if valid

```
Memoria App
    │  X-Memoria-Token: <session-token>
    ▼
Cloudflare Worker (media.memoria.app)
    │  validates token → Redis
    ▼
R2 Private Bucket
```

**Cost:** Cloudflare Workers free tier = 100,000 requests/day free. Paid plan $5/month for 10M requests.

#### Option B — Backend Proxy (Simpler, slower)
All media requests go through your Express server which streams from R2. No direct client-R2 URL.
- Adds latency and server bandwidth cost
- Not recommended for media/photos at scale

#### Option C — Short-lived Signed URLs (Current + Hardened)
Keep presigned URLs but reduce expiry from 3600s to **300s (5 minutes)**. Token is useless after 5 min even if leaked.
- Zero additional cost
- Can be done **right now** — change `R2_PRESIGN_GET_SECONDS=300` in `.env`
- Not perfect but significantly reduces exposure window

### Recommendation
- **Before launch:** implement Option C (short expiry) — 5 minutes of work
- **Post-launch (v1.1):** implement Option A (Worker proxy) — 2-3 days of work

---

## 3. SQL Operation Logs in Admin Panel

### What PostgreSQL Provides
PostgreSQL has built-in logging and the `pg_stat_statements` extension that tracks:
- Queries executed
- Execution time
- Call count
- Rows returned/affected

### Can it be surfaced in admin?

**Yes — if your DB host allows it.**

| Provider | pg_stat_statements available | Notes |
|---|---|---|
| Supabase | Yes (built-in) | Available in dashboard + queryable |
| Neon | Yes | Via `neon_superuser` role |
| Railway | Limited | Basic logs only |
| Self-hosted | Full control | Enable in `postgresql.conf` |
| RDS/Aurora | Yes | Via Performance Insights |

### What you can show in admin panel
```sql
-- Top slow queries
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;

-- Most called queries
SELECT query, calls
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 20;
```

These can be exposed as a `/admin/db/slow-queries` endpoint — read-only, admin-auth protected.

### Cost
- `pg_stat_statements`: **free**, built into PostgreSQL
- Admin endpoint development: **2-3 hours**
- No additional infrastructure needed

---

## 4. What to Implement Before Launch (Priority Order)

### Must Do (Zero/Near-Zero Cost)

| # | Action | Time | Cost |
|---|---|---|---|
| 1 | Restrict DB to server IP + your IP only (allowlist) | 15 min | Free |
| 2 | Reduce presigned URL expiry to 300s | 5 min | Free |
| 3 | Ensure all admin routes have auth middleware | 1-2 hrs | Free |
| 4 | Set strong `AI_INTERNAL_SECRET` in production | 5 min | Free |
| 5 | Rotate all secrets before launch (JWT, R2 keys) | 30 min | Free |
| 6 | Enable HTTPS only, disable HTTP | 15 min | Free |
| 7 | Set `NODE_ENV=production` in prod `.env` | 5 min | Free |
| 8 | Rate limit auth endpoints (login, OTP) | 2-3 hrs | Free |

### Should Do (Low Cost)

| # | Action | Time | Cost |
|---|---|---|---|
| 9 | IP allowlist on RabbitMQ and Redis | 30 min | Free |
| 10 | Enable pg_stat_statements for query monitoring | 30 min | Free |
| 11 | Set up error alerting (Sentry free tier) | 1 hr | Free |

### Post-Launch (Planned)

| # | Action | Time | Cost |
|---|---|---|---|
| 12 | WireGuard VPN for DB access | 4-6 hrs | $6/month |
| 13 | Cloudflare Worker media proxy | 2-3 days | $0-5/month |
| 14 | pg_stat_statements in admin panel | 2-3 hrs | Free |
| 15 | Audit log table (who did what in admin) | 1 day | Free |

---

## 5. Total Security Cost Summary

| Phase | Monthly Cost | One-time Setup |
|---|---|---|
| Pre-launch (all free items) | $0 | ~1 day |
| Post-launch v1 (VPN) | $6 | 4-6 hrs |
| Post-launch v1.1 (Worker proxy) | $0-5 | 2-3 days |
| **Total at scale** | **$6-11/month** | |

---

## 6. What This Does NOT Cover (Future Scope)

- SOC 2 compliance
- End-to-end encryption of stored media
- GDPR data export/deletion automation
- Penetration testing
- WAF (Web Application Firewall) — Cloudflare free tier covers basic DDoS
