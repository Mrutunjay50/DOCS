# Memoria — Security Plan

---

## What We Are Securing

Three things matter most:
1. The database (where all user data lives)
2. Photo/media access (who can see uploaded photos)
3. Server activity logs (what is happening inside the app)

---

## 1. Database Protection — VPN Access

### The Problem
Right now the database can be accessed by anyone who has the password string. That is a risk.

### The Fix
We will set up a **private tunnel (VPN)** so the database is completely hidden from the internet. To connect to the database, you must first connect to the VPN. No VPN = no access, even if someone has the password.

Think of it like a locked building — the VPN is the key to enter the building, and the database password is the key to a specific room inside.

### Timeline
- Before launch: restrict database access to only our server's IP address *(free, 15 minutes)*
- After launch: set up full VPN tunnel *(₹500-800/month for the VPN server)*

---

## 2. Photo & Media Protection — Signed URLs

### The Problem
When the app shows a photo, it generates a temporary link to that photo. Currently that link works for 1 hour and anyone who gets that link can view the photo.

### The Fix (Before Launch)
Reduce the link lifetime from **1 hour → 5 minutes**. Even if someone copies the link, it stops working in 5 minutes. This costs nothing and takes 5 minutes to implement.

### The Fix (After Launch)
Build a system where photo links only work if the request comes from the Memoria app. If someone tries to open the link in a browser or another app, it gets blocked.

### Timeline
- Before launch: 5-minute expiry links *(free)*
- After launch: app-only access system *(free to $400/month depending on scale)*

---

## 3. Database Activity Logs in Admin Panel

### The Problem
We currently have no visibility into what database queries are running, which ones are slow, or if something unusual is happening.

### The Fix
PostgreSQL (our database) has a built-in feature that tracks every query — how often it runs, how long it takes, and how many rows it touches. We can surface this inside the admin panel so you can monitor database health without needing a developer.

### What You Would See in Admin
- Slowest running queries
- Most frequently called queries
- Any unusual spikes in database activity

### Timeline
- Can be added to admin panel in 2-3 hours *(free)*
- Depends on which database host is being used (Supabase, Neon, Railway etc.)

---

## 4. What Gets Done Before Launch

All of these are free and take less than a day total.

| # | What | Why | Time |
|---|---|---|---|
| 1 | Lock database to our server IP only | Stops random access attempts | 15 min |
| 2 | Reduce photo link expiry to 5 minutes | Limits exposure if link is leaked | 5 min |
| 3 | Protect all admin routes with login | Only you can access admin panel | 1-2 hrs |
| 4 | Change all default secrets to strong ones | Default values are publicly known | 30 min |
| 5 | Force HTTPS everywhere | Encrypts all data in transit | 15 min |
| 6 | Rate limit login and OTP attempts | Blocks brute force attacks | 2-3 hrs |
| 7 | Lock Redis and RabbitMQ to server IP | Stops external access to job queues | 30 min |
| 8 | Set up error alerts (Sentry free tier) | Get notified when something breaks | 1 hr |

---

## 5. What Gets Done After Launch

| # | What | Monthly Cost | Timeline |
|---|---|---|---|
| VPN for database access | ₹500-800/month | Month 1 after launch |
| App-only photo access via Cloudflare | Free-₹400/month | Month 2 after launch |
| DB activity logs in admin panel | Free | Month 1 after launch |
| Audit log (track all admin actions) | Free | Month 2 after launch |

---

## 6. Total Cost

| Phase | Monthly Cost |
|---|---|
| Before launch | ₹0 |
| After launch (basic) | ₹500-800/month |
| After launch (full security) | ₹800-1,200/month |

