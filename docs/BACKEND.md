# Backend — Structure & Concepts

> **بورس رادار** · Bourse Radar API — Tehran Stock Exchange quantitative ranking engine
> **Stack:** Fastify 5 · TypeScript (Node16) · PostgreSQL 16 · Redis 7 · node-cron · Playwright

This document explains **what each part of the backend does and why it exists**.
It is a map, not a tutorial — read it to orient yourself before changing code.

---

## Table of contents

- [Table of contents](#table-of-contents)
- [1 . What the backend is for](#1-what-the-backend-is-for)
- [2 . The one-line mental model](#2-the-one-line-mental-model)
- [3 . Directory structure](#3-directory-structure)
  - [The `#` import aliases](#the-import-aliases)
- [4 . Request lifecycle](#4-request-lifecycle)
- [5 . Boot sequence](#5-boot-sequence)
- [6 . Layer by layer](#6-layer-by-layer)
  - [6.1 Config — `src/config/`](#61-config-srcconfig)
  - [6.2 Plugins — `src/plugins/`](#62-plugins-srcplugins)
  - [6.3 Routes — `src/routes/`](#63-routes-srcroutes)
  - [6.4 Scrapers — `src/scrapers/`](#64-scrapers-srcscrapers)
  - [6.5 Services — `src/services/`](#65-services-srcservices)
  - [6.6 Jobs — `src/jobs/`](#66-jobs-srcjobs)
  - [6.7 Utils — `src/utils/`](#67-utils-srcutils)
- [7 . Data model](#7-data-model)
  - [YTD lives in JSONB, not columns](#ytd-lives-in-jsonb-not-columns)
- [8 . The ingest pipeline](#8-the-ingest-pipeline)
  - [Archive mode (backfill)](#archive-mode-backfill)
- [9 . Forward P/E — the core calculation](#9-forward-pe-the-core-calculation)
  - [9.1 Codal reports are cumulative](#91-codal-reports-are-cumulative)
  - [9.2 Two bases, both reported](#92-two-bases-both-reported)
  - [9.3 Refusing to publish a number](#93-refusing-to-publish-a-number)
  - [9.4 Currency-agnostic by construction](#94-currency-agnostic-by-construction)
- [10 . Codal rate limiting & the ban problem](#10-codal-rate-limiting-the-ban-problem)
  - [10.1 Token bucket](#101-token-bucket)
  - [10.2 Shared circuit breaker](#102-shared-circuit-breaker)
  - [10.3 Early exit](#103-early-exit)
  - [10.4 Single-flight guard](#104-single-flight-guard)
  - [10.5 Operating rules](#105-operating-rules)
- [11 . Crash safety](#11-crash-safety)
- [12 . Duplicates & idempotency](#12-duplicates-idempotency)
  - [Already handled — do not add locking for these](#already-handled-do-not-add-locking-for-these)
  - [Not handled — duplicate *scrape work*](#not-handled-duplicate-scrape-work)
- [13 . Running it](#13-running-it)
  - [Prerequisites](#prerequisites)
  - [Backend](#backend)
  - [Migrations](#migrations)
  - [Verify](#verify)
- [14 . Troubleshooting](#14-troubleshooting)
- [15 . Known limitations](#15-known-limitations)
---

## 1. What the backend is for

The Tehran Stock Exchange publishes no P/E ratio for most listed companies.
Bourse Radar **computes one** and ranks stocks by how cheap they look on a
defensible basis, using only published data:

| Input | Source | What it gives |
|---|---|---|
| Live prices, volume, shares | **TSETMC** (`cdn.tsetmc.com`) | price + market cap |
| Monthly sales (فروش ماهانه) | **Codal.ir** | revenue run-rate |
| Quarterly income statements | **Codal.ir** (via Playwright) | net margin |
| USD/IRR rate | **Wallex** + **Nobitex** | USD conversion |

The product idea: **revenue run-rate × net margin ÷ shares = EPS → price ÷ EPS = P/E.**

⚠️ **This is an estimate, not a forecast.** The API returns a `disclaimer` with
every P/E and a `confidence` grade (`high` / `medium` / `low` / `non_calculable`)
so the frontend can be honest about how much to trust each number.

---

## 2. The one-line mental model

```
scrape → parse → upsert (idempotent) → compute P/E → rank → serve JSON
```

Everything else in the codebase exists to make that line **fast, safe, and
polite to the upstream servers** (TSETMC and Codal are unofficial and fragile).

---

## 3. Directory structure

```
backend/
├── src/
│   ├── index.ts              # Entry point: builds & starts the server
│   ├── config/index.ts       # Env parsing + Zod validation (fails fast)
│   │
│   ├── plugins/              # Infrastructure, registered before routes
│   │   ├── index.ts          #   Registration order + graceful degradation
│   │   ├── db.ts             #   PostgreSQL pool → server.db
│   │   ├── redis.ts          #   Redis client → server.redis (caching)
│   │   ├── cors.ts           #   Cross-origin for the Next.js frontend
│   │   ├── rate-limit.ts     #   Per-route rate limiting (Redis-backed)
│   │   └── swagger.ts        #   OpenAPI docs at /docs
│   │
│   ├── routes/               # HTTP layer — one file per resource
│   │   ├── index.ts          #   Route table + optional-route handling
│   │   ├── health.ts         #   /api/health  (no DB dependency)
│   │   ├── stocks.ts         #   /api/stocks, /api/stocks/:symbol
│   │   ├── rankings.ts       #   /api/rankings, /api/rankings/sectors
│   │   ├── sectors.ts        #   /api/sectors
│   │   ├── sector-assets.ts  #   /api/sectors/:sector
│   │   ├── price-history.ts  #   /api/prices/:symbol
│   │   ├── mcap-series.ts    #   /api/mcap-series/:symbol[/summary|/sales]
│   │   ├── quarterly.ts      #   /api/quarterly/:symbol/history
│   │   ├── earnings.ts       #   /api/earnings/:symbol
│   │   ├── orderbook.ts      #   /api/orderbook/:symbol  (live TSETMC)
│   │   ├── sales-trends.ts   #   /api/sales-trends
│   │   ├── suggestions.ts    #   /api/suggestions  (LLM narratives)
│   │   └── registerIngestRoutes.ts  # /api/admin/*  (localhost only)
│   │
│   ├── scrapers/             # External data access — no business logic
│   │   ├── tsetmc.ts         #   Symbol resolution, prices, order book
│   │   ├── codal.ts          #   Letters, reports, quarterly statements
│   │   └── fx.ts             #   USD/IRR from Wallex + Nobitex
│   │
│   ├── services/
│   │   ├── ingest.ts         # The pipeline: all DB writes live here
│   │   └── llm.ts            # OpenAI narrative generation
│   │
│   ├── jobs/index.ts         # node-cron schedule (Asia/Tehran)
│   │
│   ├── utils/
│   │   ├── logger.ts         # Pino, no transport (sandbox-safe)
│   │   ├── jalali.ts         # Jalali ↔ Gregorian conversion
│   │   └── errors.ts         # Typed Fastify errors
│   │
│   └── types/                # Shared TypeScript types
│
├── migrations/               # Numbered SQL, applied in order
│   ├── 0001_init.sql              # stocks, prices, monthly_sales, …
│   ├── 0002_rankings_view.sql     # stock_rankings materialized view
│   ├── 0003_monthly_detail.sql    # JSONB breakdown columns
│   ├── 0004_quarterly_eps.sql
│   ├── 0005_stocks_ins_code.sql
│   └── 0006_fx_and_mcap.sql       # fx_rates, market_cap_history
│
├── ARCHITECTURE.md           # Original design blueprint (aspirational)
├── docker-compose.yml        # postgres + redis + api
├── Dockerfile
└── .env.example              # Copy to .env and fill in
```

### The `#` import aliases

`package.json` and `tsconfig.json` both map subpath imports so you never
write `../../`:

```ts
import { config }        from "#config";
import { registerRoutes } from "#routes/index";
import { fetchFxRate }    from "#scrapers/fx";
```

---

## 4. Request lifecycle

```
Client
  │
  ▼
Fastify core
  │
  ├─► @fastify/cors          adds CORS headers
  ├─► @fastify/rate-limit    Redis-backed, per-route budget
  │
  ▼
Route handler (src/routes/*.ts)
  │
  ├─► server.db`…`           tagged template → parameterised SQL (no injection)
  ├─► server.redis.get/set   caching + rate-limit store
  │
  ▼
JSON response
```

Two Fastify idioms you'll see constantly:

- **Tagged templates** — ``sql`SELECT … WHERE symbol = ${sym}` ``. The `postgres`
  driver parameterises this for you, so string interpolation is *safe* here.
- **Declaration merging** — `server.db` and `server.redis` are typed by
  augmenting the `FastifyInstance` interface inside each plugin.

---

## 5. Boot sequence

`src/index.ts` runs strictly in order:

```
import "dotenv/config"     ← must be first; config validates env at import time
        ↓
buildServer()
        ↓
registerPlugins()           db → redis → cors → rate-limit → swagger(dev only)
        ↓
registerRoutes()            each route wrapped in try/catch; optional ones
        ↓                     log-and-continue on failure
initializeJobs()            schedule cron tasks
        ↓
server.listen({port, host: "0.0.0.0"})
        ↓
Signal handlers             SIGTERM/SIGINT → graceful server.close()
```

> **Degradation by design:** a failing Redis or Swagger plugin logs a warning
> and the server still starts. Only a hard failure in a *required* route throws.

---

## 6. Layer by layer

### 6.1 Config — `src/config/`

A single Zod schema parses `process.env` **at import time**. A typo in `.env`
crashes the process immediately rather than surfacing as a confusing null three
hours later.

```ts
DATABASE_URL: z.string().url(),   // required — no default
PORT: z.coerce.number().int().default(8001),
```

`z.coerce` converts `"8001"` (always a string in env) into a number. The parsed
result is re-exported as a nested, immutable object with friendlier names:

```ts
config.db.url          // from DATABASE_URL
config.app.port        // from PORT
config.freshness.priceMaxAgeSeconds
```

### 6.2 Plugins — `src/plugins/`

Infrastructure that must exist before any route runs. Order matters: rate
limiting needs Redis, and the DB must be up for queries.

| Plugin | Provides | Fails gracefully? |
|---|---|---|
| `db.ts` | `server.db` | Yes — "degraded mode" |
| `redis.ts` | `server.redis` | Yes — caching disabled |
| `cors.ts` | headers for the frontend | Yes |
| `rate-limit.ts` | request budgets | Yes — no limiting |
| `swagger.ts` | `/docs` | Yes — dev only |

### 6.3 Routes — `src/routes/`

One file per resource. Two conventions matter:

**1. Optional routes never break startup.** The route table marks each entry
`optional: true`; a throw is logged, not propagated:

```ts
{
  name: "Quarterly",
  register: (s) => registerQuarterlyRoutes(s, "/api/quarterly"),
  optional: true,          // failure logged, server still boots
}
```

**2. Admin routes are localhost-only.** `/api/admin/*` uses an `onRequest` hook
that checks the peer IP:

```ts
const LOCALHOST_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
```

Anything else gets `403` before the handler body runs.

**3. Response schemas are mandatory.** Every route declares its `200` shape (and
error shapes) so Fastify serialises and validates for you, and Swagger documents
it automatically.

### 6.4 Scrapers — `src/scrapers/`

Pure external access. **No database writes here** — scrapers return data, the
service layer decides what to persist. That separation is why you can swap a
scraper without touching the pipeline.

| Scraper | Talks to | Notes |
|---|---|---|
| `tsetmc.ts` | `cdn.tsetmc.com` | Prices, instrument resolution, order book |
| `codal.ts` | `search.codal.ir` + `www.codal.ir` | Letters → report HTML → parsed tables |
| `fx.ts` | Wallex, Nobitex | Cross-validates two sources → quality grade |

`codal.ts` is the most complex file because Codal returns **HTML tables** and
only exposes a paginated JSON search:

- `searchLetters(symbol, { PageNumber })` — 20 letters per page
- `fetchReportHtml(url)` — the report body
- `extractMonthlySalesFull(html)` / `extractIncomeStatement(html)` — parse to
  typed rows
- `fetchQuarterlyFinancials(symbol)` — **needs Playwright**, because income
  statements render client-side

`fx.ts` returns a **quality grade**, which the whole dataset depends on:

| Grade | Meaning |
|---|---|
| `valid` | Nobitex and Wallex agree within 2% |
| `fallback` | only one source answered |
| `suspicious` | sources disagree beyond tolerance |

### 6.5 Services — `src/services/`

Business logic. **Every database write lives in `ingest.ts`.**

- **`ingest.ts`** — the pipeline. Also owns `WATCHLIST` (the curated symbol
  universe) and `toDiscreteQuarters()`, the differencing logic described below.
- **`llm.ts`** — generates Persian analytical narratives. It explains *why* a
  stock ranks well from the metrics; it never emits buy/sell advice.

### 6.6 Jobs — `src/jobs/`

`node-cron` schedules, all in **`Asia/Tehran`** — ordering encodes dependencies:

| Time | Job | Why then |
|---|---|---|
| 06:01 | `ingest-fx-rate` | USD conversion needed by everything after |
| 06:00 | `ingest-symbols` | Refresh the symbol universe |
| 06:30 | `ingest-market-cap-history` | Needs today's prices + FX |
| every 5 min, 09–12 | `ingest-prices` | Trading hours only, Sun–Thu |
| 14:00 | `ingest-monthly-sales` | After Codal publishes |
| 15:00 | `ingest-quarterly-financials` | Playwright, 10–15 min |
| 20:00 | `compute-forward-pe` | After all inputs are fresh |
| 21:00 | `compute-rankings` | Refresh the materialized view |
| 22:00 | `generate-narratives` | Top-20 only |

Every job body is wrapped in `try/catch` — **a failed cron task logs and never
kills the process.**

### 6.7 Utils — `src/utils/`

- **`logger.ts`** — Pino with **no transport**. This is deliberate: `pino-pretty`
  spawns a worker thread, which fails in containers and sandboxes. Request
  logging is handled by Fastify's own logger.
- **`jalali.ts`** — Jalali ↔ Gregorian conversion. Iranian fiscal data is
  Jalali; the database stores ISO Gregorian.
- **`errors.ts`** — `@fastify/error` constructors so HTTP status codes are
  declared, not hard-coded.

---

## 7. Data model

Six tables, each with a primary key chosen to make writes idempotent.

| Table | Primary key | Grain | Written by |
|---|---|---|---|
| `stocks` | `(symbol)` | one row per instrument | `upsertStocks` |
| `prices` | `(symbol, timestamp)` | time-series ticks | `insertPrices` |
| `monthly_sales` | `(symbol, month_end)` | one row per month | `upsertMonthlySalesRow` |
| `quarterly_financials` | `(symbol, fiscal_year, quarter)` | one row per quarter | `syncQuarterlyFinancials` |
| `forward_pe` | `(symbol, calculated_at)` | append-only snapshots | `recomputeForwardPe` |
| `market_cap_history` | `(symbol, date)` | one row per day | `syncMarketCapHistory` |
| `fx_rates` | `(rate_date)` | one row per day | `syncFxRates` |

Supporting: `stock_rankings` is a **materialized view** refreshed by cron, not a
table you write to directly.

### YTD lives in JSONB, not columns

`monthly_sales.detail` holds the structured Codal breakdown — goods list,
totals, YTD figures:

```jsonc
{
  "goods": [ /* per-product rows */ ],
  "totals": [ /* row-coded totals */ ],
  "monthlySalesTotal": 25524237,
  "ytdSalesTotal": 69253586,
  "priorYtdSalesTotal": 35191814,
  "domesticMonthly": null,
  "exportMonthly": 32476
}
```

This keeps the schema stable while Codal's report layout evolves. **Note the
distinction** — the USD variants (`sales_usd`, `ytd_total_usd`, …) are *real
columns*; the Rial variants above are inside `detail`.

---

## 8. The ingest pipeline

`runFullIngest()` executes six phases in strict dependency order:

```
Phase 0   FX rate         Wallex + Nobitex → fx_rates
Phase 1   Symbols+prices  TSETMC → stocks, prices
Phase 1b  Market cap      prices × shares × FX → market_cap_history
Phase 2   Monthly sales   Codal → monthly_sales
Phase 3   Quarterly       Codal + Playwright → quarterly_financials
Phase 4   Forward P/E     all inputs → forward_pe
Phase 5   Rankings        REFRESH MATERIALIZED VIEW stock_rankings
```

It is wrapped in `try/finally` so the Playwright browser is **always** closed:

```ts
try   { /* phases */ }
finally { await closeBrowser(); }
```

### Archive mode (backfill)

Separate entry points let you backfill history without re-running everything:

```
GET /api/admin/ingest                        → full pipeline
GET /api/admin/ingest?symbol=فسبزوار         → Codal archive, one symbol
GET /api/admin/ingest?symbols=all            → watchlist archive
GET /api/admin/ingest?symbols=فولاد,فخوز     → selected symbols
```

`from` / `to` are **Jalali** bounds (`1402/01/01` … `1405/12/29`).

> ⚠️ `ingestArchiveForSymbol` currently accepts `from`/`to` but only uses them
> to bound the page loop — it fetches the newest pages first. Treat the date
> range as a *hint*, not a guarantee.

---

## 9. Forward P/E — the core calculation

This is the one non-obvious piece of the domain, so it gets its own section.

### 9.1 Codal reports are cumulative

Iranian income statements report **year-to-date** figures, not discrete
quarters. The 6-month column already *includes* the 3-month column. So you
cannot read Q2 straight off the page:

```
Codal column   Value      True quarter
─────────────  ─────────  ─────────────────
3 ماهه         10         Q1 = 10
6 ماهه         25         Q2 = 25 − 10 = 15
9 ماهه         33         Q3 = 33 − 25 = 8
12 ماهه        45         Q4 = 45 − 33 = 12
```

`toDiscreteQuarters()` does this differencing, and refuses to emit a quarter
whose predecessor is missing (a Q3 without a Q2 can't be differenced
correctly, so it's skipped rather than guessed).

### 9.2 Two bases, both reported

The API deliberately publishes **two** P/E figures and explains the gap:

| Basis | Formula | What it assumes |
|---|---|---|
| **Headline** | last 3 months of sales × 4, × margin | recent run-rate continues |
| **Baseline** | trailing 12 months of sales, × margin | nothing — purely historical |

```
annualSales  = (SUM(last 3 months) or AVG × 3) × 4
EPS          = annualSales × net_margin ÷ shares
P/E          = price ÷ EPS
P/E(12m)     = price ÷ (trailing12Sales × margin ÷ shares)
```

When the two diverge by more than **25%**, confidence is downgraded and the
response says so — because the cheap number is mostly extrapolation.

### 9.3 Refusing to publish a number

Margin comes from the most recent quarterly statement (`net_margin > 0`,
last 365 days). Banks/insurers/holdings may fall back to a **sector default
margin**, but **non-financials never do** — an unsourced default would produce a
confidently-wrong P/E. Those symbols return:

```json
{
  "forwardPe": null,
  "confidence": "non_calculable",
  "method": "unavailable",
  "disclaimer": "صورت مالی فصلی در دسترس نیست…"
}
```

`non_calculable` is a first-class state in the frontend, not an error.

### 9.4 Currency-agnostic by construction

P/E is a ratio, so rial-vs-dollar cancels out:

```
priceRial / epsRial  ==  priceUsd / epsUsd
```

FX only matters for **display** (USD market cap, USD sales) and for the
`fx_quality` badge. A `fallback` FX rate therefore does not corrupt P/E.

---

## 10. Codal rate limiting & the ban problem

**Codal bans by IP, and the ban is global** — it covers the search host and the
report host alike. A single archive backfill fires ~20 paginated searches plus
one fetch per report, which is enough to trip it from a residential IP.

### 10.1 Token bucket

`RateLimiter` (in `codal.ts`) serialises calls so they can't burst:

- **capacity 1** — one request at a time
- **floor 1200ms** between request *starts*
- **adaptive** — the interval **doubles on every 429** and decays ×0.9 on
  success, capped at 5000ms
- **3 attempts** with exponential backoff + jitter
- honours `Retry-After` when Codal sends one

```ts
searchLimiter.run(() => fetch(...))   // search.codal.ir
reportLimiter.run(() => fetch(...))   // www.codal.ir
```

### 10.2 Shared circuit breaker

Because the ban is per-IP rather than per-host, both limiters consult **one
shared breaker**:

| Constant | Value | Effect |
|---|---|---|
| `THRESHOLD` | 6 | throttles inside the window before tripping |
| `WINDOW_MS` | 60s | rolling counting window |
| `COOLDOWN_MS` | 120s | how long we stay silent once tripped |

After 6 throttles, **all** Codal traffic pauses:

```
[codal] circuit OPEN — pausing all Codal traffic for 120s after 6 throttles
[codal] breaker open — waiting 119s before any request
```

Silence is the only cure — further requests *extend* the ban.

### 10.3 Early exit

The ingest loops check `isCodalCoolingDown()` **before** each symbol or page
and stop early:

```
⚠ 14 symbols skipped — cooling down 97s after 6 throttles
```

Without this, one ban would trigger 100 more requests that keep you banned.

### 10.4 Single-flight guard

Overlapping ingests double the request rate from one IP — the fastest way to
earn a ban. A module-level flag rejects the second caller:

```json
HTTP 409
{
  "ok": false,
  "error": "ingest busy: full pipeline since 1s ago — wait for it to finish",
  "retryAfterSec": 120,
  "throttle": "ok"
}
```

Every ingest response also carries `throttle` and `coolingDown` so a client can
tell "done" from "banned, wait".

### 10.5 Operating rules

- **Never poll ingest.** Fire once, read the summary `{ fx, stocks, prices,
  mcap, sales, quarterly, pe }`.
- **`409` means wait**, not retry.
- **`coolingDown: true` means stay silent for 2–3 minutes.** Retrying resets the
  ban clock.
- For maximum safety, drop `CODAL_CONCURRENCY` (currently 3) to 1.

---

## 11. Crash safety

An ingest failure must never take the API offline.

**`mapWithConcurrency` uses `Promise.allSettled`**, not `Promise.all`. With
`Promise.all`, the first rejection leaves sibling workers running; their
eventual rejections become *unhandled*, which used to hit:

```ts
process.on("unhandledRejection", () => process.exit(1));   // ← removed
```

…and kill the whole server. `allSettled` waits for every worker, then rethrows
the first real failure so the caller still sees the error.

**`unhandledRejection` is now log-only.** An `uncaughtException` still exits,
since that leaves state undefined.

**Orphaned promises are guarded.** The monthly-sales deadline uses
`Promise.race`, which would otherwise leave the losing `fetchMonthlySales`
promise rejecting with nobody listening — plus a leaked `setTimeout`. Both are
now cleaned up in `finally` with a no-op `.catch`.

---

## 12. Duplicates & idempotency

### Already handled — do not add locking for these

| Data | PK | Behaviour |
|---|---|---|
| Stock metadata | `(symbol)` | `ON CONFLICT DO UPDATE` overwrites |
| Monthly sales | `(symbol, month_end)` | same month refreshes the same row |
| Quarterly | `(symbol, fiscal_year, quarter)` | same quarter refreshes the same row |
| Market cap | `(symbol, date)` | same day refreshes |
| FX | `(rate_date)` | same day refreshes |

Running ingest twice **cannot** create duplicate rows. It only overwrites the
same keys with fresher data.

`forward_pe` is the deliberate exception — an **append-only history** capped at
30 rows per symbol by a `ROW_NUMBER()` prune after each insert.

### Not handled — duplicate *scrape work*

The remaining risk is **wasted upstream traffic**: re-crawling symbols that were
just crawled. Two guards cover the common cases:

1. **Single-flight** (§10.4) — no two concurrent runs.
2. **Cooldown early-exit** (§10.3) — no crawling through an active ban.

A third, optional guard is a **freshness check** — skip a symbol whose
`monthly_sales.fetched_at` is newer than N seconds. It is not implemented
because the right window is a product decision (15 min for cron, 24h for a
backfill). If you add it, thread it as a `?freshness=<seconds>` query param
rather than a constant, so cron and interactive calls can differ.

---

## 13. Running it

### Prerequisites

Docker Desktop (PostgreSQL 16 + Redis 7) must be running.

```bash
docker compose up -d postgres redis
```

### Backend

```bash
cd backend
cp .env.example .env      # fill in DATABASE_URL, REDIS_URL, OPENAI_API_KEY
npm install
```

Two launch methods exist. **Use the first** — the second is a fallback for
environments where process spawning is restricted:

```bash
# ✅ works everywhere
node --experimental-strip-types src/index.ts

# ⚠️ only if spawning is allowed
npm run dev              # tsx watch
```

> **Why not `npm run dev` by default?** `tsx`/`esbuild` and Next.js both spawn
> child processes. In sandboxes and some containers that fails with
> `spawn EPERM`. `--experimental-strip-types` runs TypeScript natively in a
> single process, so it has no such dependency.

### Migrations

Applied in filename order on first Postgres boot via
`./migrations:/docker-entrypoint-initdb.d`. For an existing volume, apply
manually:

```bash
psql "$DATABASE_URL" -f migrations/0006_fx_and_mcap.sql
```

### Verify

```bash
curl localhost:8001/api/health        # {"status":"ok",...}
open  localhost:8001/docs             # Swagger UI (dev only)
```

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `password authentication failed` | missing `import "dotenv/config"` | must be the first import in `index.ts` |
| `column "ytd_total_rial" does not exist` | YTD Rial lives in `detail` JSONB | read `detail->>'ytdSalesTotal'` |
| `column "net_margin" does not exist` | real column is `net_margin` on `quarterly_financials` | check the migration, not the code |
| `Cannot use namespace 'IORedis' as a type` | wrong ioredis import | use `import { Redis } from "ioredis"` |
| `spawn EPERM` | blocked child-process spawn | use `node --experimental-strip-types` |
| `browserType.launch: spawn EPERM` | Playwright can't start Chrome | run ingest on the host, not the sandbox |
| `EADDRINUSE 0.0.0.0:8001` | previous instance still running | `netstat -ano \| findstr 8001` → `Stop-Process -Id <pid> -Force` |
| Everything `non_calculable` | Phase 3 (Playwright) never ran | run `GET /api/admin/ingest` on a machine that can spawn Chrome |
| Constant `429` from Codal | cooldown in effect | **wait 2–3 min**, do not retry |

---

## 15. Known limitations

Honest list of what's incomplete or environment-bound:

- **Quarterly financials need a real browser.** Playwright cannot launch in a
  sandbox, so most symbols stay `non_calculable`. Run ingest on the host.
- **`from` / `to` in archive mode are advisory** — the page loop fetches newest
  first rather than jumping to a date.
- **`generate-narratives` is a stub** — the cron job logs but calls nothing.
- **`llm.ts` has no timeout/fallback**; a slow OpenAI call can hang the route.
- **Quarterly concurrency is 2** while each worker spawns a browser. Consider
  lowering it to 1 to reduce memory pressure.
- **Most symbols lack full 36-month sales history** — the archive backfill is
  incomplete.
- **No authentication.** The API is designed to run behind a private network;
  admin routes are protected only by a localhost-IP check.
- **Watermarks:** migrations auto-apply only on a **fresh** Postgres volume. An
  existing database needs new migrations applied by hand.
