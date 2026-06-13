# PDF Tools POC — Module 05 (merge / compress / edit / DOC↔PDF)

A working proof-of-concept of the Module 05 "PDF utility tools" from the Node.js
Backend Development Plan. It runs the tools on a **job queue + worker** model,
exposes a **test UI**, and ships a **benchmark + 10,000-user capacity estimate**
built from *measured* per-operation times (e.g. "how long to merge a 20 MB PDF
with a 20 MB PDF").

> Question this answers: *given real per-op timings, how many workers + how much
> storage does 10,000 users need?* See [`bench/results/estimate.md`](bench/results/estimate.md).

---

## Architecture

```
 Browser UI (public/)                 ┌─────────────── worker container ───────────────┐
        │  multipart upload            │  BullMQ Worker(s)                                │
        ▼                              │   ├─ merge      pdf-lib                          │
 ┌──────────────┐   enqueue job        │   ├─ compress   ghostscript (child_process)      │
 │  API (Express)│ ───────────────►  Redis  ├─ edit       pdf-lib                          │
 │  src/api      │   (BullMQ on        │   ├─ doc-to-pdf  libreoffice --headless           │
 │  + inline ops │    REMOTE Redis)    │   └─ pdf-to-doc  pdftotext + docx builder         │
 └──────┬───────┘ ◄─────────────── result  (qpdf decrypts encrypted inputs before merge)  │
        │  poll status / download      └──────────────────────────────────────────────────┘
        ▼                                       shared /data volume (uploads + outputs)
   GET /api/job/:queue/:id
```

- **Broker: BullMQ on Redis** (the design doc says *"RabbitMQ / Redis / whatever"*).
  BullMQ gives job state, retries, timeouts, progress and result storage on one
  Redis. The `RABBITMQ_URL` in `.env` is kept for the alternative broker; the
  job lifecycle maps 1:1 (durable queue per op + result store).
- **Two queues** mirror the doc's split: `pdf-light` (merge, edit) and
  `pdf-heavy` (compress, DOC↔PDF) — the latter low-concurrency + resource-capped
  because Ghostscript/LibreOffice are heavy.
- **Inline vs queued**: small light ops (≤ `INLINE_MAX_BYTES`, 2 MB) run
  synchronously and return `200`; everything else is enqueued and returns `202`,
  exactly as the doc specifies.

---

## Quick start (Docker — full fidelity)

The host has Node + Docker + Redis, but **not** Ghostscript/LibreOffice/qpdf, so
the worker runs in a container that bundles them (+ Noto Devanagari fonts).
The broker is the **remote Redis** in `.env` (no local Redis needed).

```bash
docker compose build            # worker image bundles libreoffice/ghostscript/qpdf/poppler
docker compose up -d api worker # api on :3000, worker on the remote Redis
# open the UI:
start http://localhost:3000     # (Windows) or just browse there
```

Tear down: `docker compose down`.

### Test UI
Open <http://localhost:3000>. Pick a tab (Merge / Compress / Edit / DOC→PDF /
PDF→DOC), upload file(s), run it, and watch **queue wait + processing time**,
input/output sizes, compression ratio, then download the result.

---

## Benchmark + estimate

```bash
# 1. generate fixtures (image PDFs at 5/10/20/40 MB, text PDFs, DOCX w/ Hindi)
docker compose run --rm --no-deps -v "${PWD}/bench:/app/bench" worker node bench/gen-fixtures.js

# 2. run the benchmark (calls tools directly, median of REPS=3 runs)
docker compose run --rm --no-deps -v "${PWD}/bench:/app/bench" worker node bench/benchmark.js

# 3. turn measured times into a 10k-user capacity model
node bench/estimate.js
#   …or a heavier scenario:
DAU_FRACTION=1.0 OPS_PER_USER=10 PEAK_TO_AVG=4 ACTIVE_HOURS=8 node bench/estimate.js
```

(On Windows PowerShell use `${PWD}`; the bench dir is mounted so fixtures and
`bench/results/results.json` land on the host.)

### Measured timings on this machine (median of 3, Docker worker)

| Operation | Input | Median |
|-----------|-------|-------:|
| **merge** | 5 MB + 5 MB   | ~53 ms |
| **merge** | 10 MB + 10 MB | ~73 ms |
| **merge** | **20 MB + 20 MB** | **~124 ms** |
| **merge** | 20 MB + 40 MB | ~376 ms |
| **edit** (3 ops) | 5 MB  | ~19 ms |
| **edit** (3 ops) | 20 MB | ~167 ms |
| **compress** level=medium | 10 MB | ~248 ms |
| **compress** level=medium | 40 MB | ~828 ms |
| **compress** target=2 MB  | 20 MB | ~2.5 s (→ lands < 2 MB @ 100 dpi) |
| **compress** target=2 MB  | 40 MB | ~4.7 s |
| **doc-to-pdf** | ~5-page DOCX  | ~1.24 s |
| **doc-to-pdf** | ~25-page DOCX (w/ Hindi tables) | ~1.28 s |
| **pdf-to-doc** | 5-page text PDF  | ~16 ms |
| **pdf-to-doc** | 20-page text PDF | ~26 ms |

Takeaways:
- **Merge/edit are cheap** (pure-JS pdf-lib): a 20+20 MB merge is ~0.1 s.
- **Compression's target-size mode is the slow merge-tool path** (~2.5 s for
  20 MB) because Ghostscript re-renders while stepping DPI down.
- **DOC→PDF (LibreOffice) is the real cost driver** at ~1.3 s/doc and low
  concurrency — it dominates capacity sizing below.

### 10,000-user estimate (heavier scenario: 10k DAU × 10 ops/day = 100k ops/day)

| Op | Mix | Peak ops/s | Service | Concurrent slots |
|----|----:|-----------:|--------:|-----------------:|
| merge | 20% | 2.78 | 124 ms | 0.49 |
| compress | 30% | 4.17 | 248 ms | 1.48 |
| edit | 10% | 1.39 | 167 ms | 0.33 |
| **doc-to-pdf** | 25% | 3.47 | **1.28 s** | **6.35** |
| pdf-to-doc | 15% | 2.08 | 26 ms | 0.08 |

→ **light queue: 1 worker proc** (@4 conc) · **heavy queue: 4 worker procs**
(@2 conc) · **~5 worker processes total**, ~8 CPU cores for heavy work.
DOC→PDF alone is ~80% of the heavy load. Storage ≈ output-size × volume ×
retention (dominated by merge outputs). Numbers regenerate from your own
benchmark + assumption knobs — see `bench/estimate.js`.

---

## API

| Method/Route | Body | Returns |
|---|---|---|
| `POST /api/pdf/merge` | `files[]`, `order[]?`, `passwords?` | `200` inline (small) or `202 {jobId}` |
| `POST /api/pdf/compress` | `file`, `level` \| `target_mb` | `202 {jobId}` |
| `POST /api/pdf/edit` | `file`, `operations[]` | `200`/`202` |
| `POST /api/convert/doc-to-pdf` | `file` (.doc/.docx) | `202 {jobId}` |
| `POST /api/convert/pdf-to-doc` | `file`, `ocr_fallback=auto` | `202 {jobId}` |
| `GET /api/job/:queue/:id` | — | `{state, progress, result}` |
| `GET /api/download/:name` | — | output file |

`edit` operations:
```json
[ { "type":"text", "page":1, "x":72, "y":680, "text":"Approved" },
  { "type":"highlight", "page":1, "rect":[60,400,520,420] },
  { "type":"stamp", "page":1, "x":350, "y":700, "text":"DRAFT" } ]
```

---

## What's faithful vs. simplified (POC honesty)

- ✅ **Merge** copies pages in client order; **qpdf** decrypts encrypted inputs
  (with supplied password) before merge.
- ✅ **Compress** maps `low/medium/high → /screen /ebook /printer`; target-size
  mode steps DPI down until ≤ cap; already-tiny files aren't bloated; hard
  subprocess timeout.
- ✅ **Edit** applies text/highlight/stamp at PDF-point coords with pdf-lib.
- ✅ **DOC→PDF** via LibreOffice headless; **Devanagari renders** (verified by
  re-extracting Hindi text from the output — no tofu).
- ⚠️ **PDF→DOC** uses **`pdftotext` + a DOCX builder** (the doc's "pdf2json +
  docx" path) rather than `soffice --convert-to docx`, because LibreOffice
  imports PDFs into *Draw*, which has no DOCX export. Empty extracted text is the
  **scanned-PDF signal** → flags `ocrRequired`. **The Django OCR fallback is
  detected but not wired** (out of scope for this POC).
- ⚠️ Benchmark **fixtures are random-noise images** — worst-case-incompressible,
  so file sizes are exact/predictable; real photographic PDFs compress further.
- ⚠️ Storage uses a shared volume (not S3/MinIO); `estimate.js` storage figures
  use rough per-op output sizes — tune them for your data.

---

## File map

```
src/config.js              env + .env loader, queue routing, timeouts
src/queue.js               BullMQ connection/queues (REDIS_URL aware)
src/api/server.js          Express: upload, enqueue/inline, status, download
src/worker/worker.js       BullMQ workers (light + heavy) with timing
src/worker/dispatch.js     op -> tool map (shared by worker + benchmark)
src/worker/tools/*.js      merge, compress, edit, docToPdf, pdfToDoc
src/lib/{storage,timing,docxBuilder}.js
public/                    test UI (index.html, app.js, style.css)
bench/gen-fixtures.js      generate sized PDFs + Hindi DOCX (zero-dep PNG/ZIP)
bench/benchmark.js         direct-call timing harness -> results.json
bench/estimate.js          10k-user capacity model -> estimate.md
Dockerfile.worker          node + libreoffice + ghostscript + qpdf + poppler + fonts
Dockerfile.api             node only
docker-compose.yml         api + worker on remote Redis, shared /data volume
.env                       REDIS_URL / RABBITMQ_URL / DATABASE_URL (gitignored)
```

## Host dev mode (no Docker)
`npm i` then `npm run api` + `npm run worker`. Merge/edit/pdf-to-doc work, but
**compress and doc-to-pdf need gs/soffice on PATH** (use Docker for those).
