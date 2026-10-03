# Bourse Radar API — Architecture & Implementation Blueprint
## Tehran Stock Exchange (TSE) Quantitative Ranking Engine

> **Version:** 0.1.0 · **Framework:** Fastify + TypeScript · **DB:** PostgreSQL 16 · **Cache:** Redis

---

## 0. TL;DR — Minimum Viable Product

The core of Bourse Radar is a single pipeline: **ingest → estimate → rank → narrate**.

| Layer | Responsibility | Key File |
|---|---|---|
| **Ingestion** | Fetch prices (TSETMC) + monthly sales & quarterly financials (Codal.ir) | `src/scrapers/` |
| **Estimation** | Forward P/E = (3M Sales Avg × 12 × Net Margin) / Shares | `forward_pe.ts` / `forward_pe.py` |
| **Ranking** | Composite score (inverse P/E, confidence, liquidity, stability) | `src/services/ranking.ts` |
| **Narration** | LLM generates Persian analytical narrative (NO buy/sell signals) | `src/services/llm.ts` |
| **API** | REST endpoints via Fastify | `src/routes/` |

**Run locally:**
```bash
docker compose up -d postgres redis
npm install
npx node-pg-migrate up
npm run dev
```

---

## 1. Architecture Overview

### High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     DATA SOURCES (External)                        │
│                                                                      │
│  TSETMC          Codal.ir                 Unofficial APIs          │
│  ┌─────────┐    ┌────────────┐          ┌──────────────────┐     │
│  │Prices   │    │Monthly Sales│         │cdn.tsetmc.com    │     │
│  │(live)   │    │(فروش ماهانه)│         │56+ JSON endpoints│     │
│  │Volumes  │    │Quarterly    │         │webgw.tse.ir      │     │
│  │Shares   │    │Financials   │         │gateway (rate-   │     │
│  │Sectors  │    │Events       │         │limited)         │     │
│  └────┬────┘    └──────┬─────┘          └────────┬─────────┘     │
└───────┼────────────────┼─────────────────────────┼───────────────┘
        │                │                         │
        ▼                ▼                         │
┌────────────────────────────────────────────────────────────────┐
│  1. INGESTION LAYER (scrapers/)                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐      │
│  │tsetmc-client │  │codal-client  │  │symbol-discovery  │      │
│  │(price, shares)│  │(sales, fin.)│  │(sector, isin map)│      │
│  └──────┬───────┘  └──────┬───────┘  └───────┬──────────┘      │
└─────────┼─────────────────┼──────────────────┼──────────────────┘
          │                 │                  │
          ▼                 ▼                  ▼
┌────────────────────────────────────────────────────────────────┐
│  2. CACHE LAYER (Redis)                                          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │price:{symbol}  TTL=5m    │  sales:{symbol}  TTL=1h       │   │
│  │fundamental:{symbol} TTL=1h │ forward_pe:{symbol} TTL=15m   │   │
│  │rankings:sector  TTL=15m  │ rankings:all   TTL=15m         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────┬───────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────┐
│  3. DATABASE LAYER (PostgreSQL)                                  │
│  Tables: stocks, prices, monthly_sales, quarterly_financials,  │
│          forward_pe, sector_metrics, llm_narratives,           │
│          rankings_materialized_view                             │
└─────────┬───────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────┐
│  4. PROCESSING LAYER (services/)                                 │
│  ┌────────────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │forward-pe-engine   │  │ranking       │  │llm-narrator  │   │
│  │(estimate EPS)      │  │(composite    │  │(Persian       │   │
│  │                    │  │ score)       │  │ narrative)    │   │
│  └────────┬───────────┘  └──────┬───────┘  └──────┬───────┘   │
└──────────┼─────────────────────┼──────────────────┼────────────┘
           │                     │                  │
           ▼                     ▼                  ▼
┌────────────────────────────────────────────────────────────────┐
│  5. API LAYER (routes/ — Fastify)                               │
│  GET /api/stocks         GET /api/stocks/:symbol               │
│  GET /api/rankings       GET /api/suggestions                  │
│  GET /api/sectors        GET /api/health                       │
└─────────┬───────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────┐
│  6. FRONTEND (Next.js — not part of this backend blueprint)     │
│  Serves via this API at http://localhost:8001                   │
└────────────────────────────────────────────────────────────────┘
```

### Tech Stack Rationale

| Component | Choice | Justification |
|---|---|---|
| **Framework** | **Fastify** | Schema-first validation, built-in JSON Schema serialization, superior throughput vs Express. Pino logging is structured by default. |
| **Database** | **PostgreSQL 16** | Window functions for percentile ranking, JSONB for LLM input storage, partial indexes for instrument-class queries. Raw SQL with `postgres` npm driver — no ORM overhead. |
| **Cache** | **Redis (ioredis)** | Critical for TSETMC rate-limit avoidance. TTL-based staleness for price data (5 min) vs. fundamental data (15–60 min). |
| **Scheduler** | **node-cron** | Simpler than BullMQ for periodic scrapers. Cron schedules handle daily market-open ingestion. |
| **LLM** | **OpenAI SDK** | `zod-response` or native structured output with Zod schemas. Fallback to raw rankings when LLM fails. |
| **Testing** | **Vitest** | Native Vite compatibility, Fastify `.inject()` for route testing, testcontainers for Postgres isolation. |

### Deployment

**Primary: Docker Compose (development) → VPS (production)**

```
# docker-compose.yml
services:
  postgres  # PostgreSQL 16-alpine
  redis      # Redis 7-alpine
  api        # Node 20-alpine, built from Dockerfile
```

**Production VPS deployment:**
- Ubuntu 22.04 LTS + Docker Compose
- Nginx reverse proxy (TLS termination)
- Redis + Postgres in separate containers
- API container with `--read-only` filesystem, non-root user
- Cron-based health checks + auto-restart policy
- Backup: `pg_dump` daily → S3-compatible storage

**Serverless note:** Not recommended due to warm-start latency > 1s for LLM calls + Redis connection limits. A VPS with 2 vCPU + 4GB RAM is sufficient for 50 req/s.

---

## 2. Data Layer

### TSETMC Unofficial API Endpoints [citation:4]

**No official public REST API exists.** The following unofficial endpoints are used:

| Endpoint | Purpose | Fields Extracted |
|---|---|---|
| `GET https://cdn.tsetmc.com/api/Static/StaticData` | Full symbol list | Symbol, ISIN, name, sector, shares outstanding |
| `GET https://cdn.tsetmc.com/api/Quote/AllData/{symbolId}` | Real-time price | Last price, open/high/low, volume, value, cdnPe, cdnEps, market cap |
| `GET https://cdn.tsetmc.com/api/MarketWatch/data` | Market watch | Sector indices, market cap distribution |
| `GET https://cdn.tsetmc.com/api/Shareholders/{symbolId}` | Shareholder data | Lock-up info (for liquidity assessment) |

**Authentication:** None required. TSETMC does not enforce API keys on these endpoints.

**Rate limits:** Unofficially, TSETMC allows ~60 requests/minute per IP. Exceeding this triggers IP-level temporary bans (HTTP 429 or connection resets). Mitigation: Redis-backed token bucket per IP + aggressive caching.

### Codal.ir Endpoints [citation:2][citation:13][citation:14]

Codal.ir is the official disclosure platform. Key data accessed via:

| Endpoint | Purpose | Fields |
|---|---|---|
| `GET https://www.codal.ir/api/Report/MonthlySales/{symbol}` | Monthly sales (فروش ماهانه) | `monthEnd`, `salesAmount`, `isEstimated`, `reportDate` |
| `GET https://www.codal.ir/api/Report/QuarterlyFinancials/{symbol}` | Quarterly P&L | `revenue`, `netProfit`, `extraordinaryIncome`, `extraordinaryExpense`, `sharesOutstanding` |
| `GET https://www.codal.ir/api/Report/CompanyProfile/{symbol}` | Static company info | `sector`, `isBank`, `isInsurance`, `isHoldingCompany` |

**Note:** Codal.ir does not have a public API. These are derived from the site's internal JSON endpoints observed through browser dev tools. They may change without notice.

### Library Recommendations

| Library | Use Case | Alternatives Considered |
|---|---|---|
| `tse-client` (npm) | Primary: TSETMC price + fundamental data | `pytse-client` (Python, but we're TypeScript) |
| `axios` + `cheerio` | Codal.ir HTML scraping fallback | Direct JSON endpoints when available |
| Custom `requests` to `cdn.tsetmc.com` | When `tse-client` doesn't expose needed endpoints | `pytsetmc-api` provides search + history in Python |

**Recommendation:** Use `tse-client` for prices and fundamentals, fallback to direct `cdn.tsetmc.com` requests when specific fields are unavailable. Use a custom scraper for Codal.ir since no maintained Node.js library exists.

### Caching Strategy (Redis)

| Key Pattern | TTL | Rationale |
|---|---|---|
| `price:{symbol}` | 5 min | Prices change rapidly; stale price = misleading P/E |
| `fundamental:{symbol}` | 10 min | EPS, shares, sector — relatively stable |
| `sales:{symbol}:{monthEnd}` | 1 hour | Monthly sales rarely change after publication |
| `quarterly:{symbol}:{fy}:{q}` | 6 hours | Quarterly reports are static after publication |
| `forward_pe:{symbol}` | 15 min | Expensive computation; 15 min is acceptable latency |
| `rankings:all` | 5 min | Recompute on schedule; cache for quick reads |
| `rankings:sector:{sector}` | 5 min | Sector-specific views |
| `llm:narrative:{symbol}` | 10 min | Expensive LLM call; short TTL for freshness |

**Cache warming:** On startup or after scheduled jobs, pre-populate `rankings:all` and `forward_pe:{symbol}` for all symbols in the database.

### Error Handling

| Failure Mode | Strategy |
|---|---|
| **TSETMC API unreachable (429, 5xx)** | Return stale cached data with `isStale: true` flag. If cache miss, return 503 with retry-after header. |
| **Codal.ir monthly sales missing** | Mark Forward P/E as `non_calculable`. Do not fabricate. |
| **Symbol not found in TSETMC** | Return 404 with suggestion to check spelling. |
| **Quarterly financials delayed (>120 days)** | Fall back to industry/sector average margin. Mark confidence as `low`. |
| **Network timeout (>10s)** | Retry 2× with exponential backoff. Then fail to fallback source. |
| **Database connection failure** | If PostgreSQL is down, serve from Redis cache only (degraded mode). |
| **LLM failure (rate limit, timeout)** | Return raw rankings without narrative narrative. Set `narrative: null` with explanation. |

### Example: `fetch_stock_data` Function

```python
from typing import Optional
from dataclasses import dataclass
from datetime import datetime, date
from io import BytesIO
import requests, time, json

@dataclass
class StockData:
    symbol: str
    name: str
    name_en: str
    sector: Optional[str]
    last_price: Optional[float]
    price_change: Optional[float]
    price_change_percent: Optional[float]
    volume: Optional[int]
    value: Optional[float]        # Trade value (IRR)
    market_cap: Optional[float]
    shares_outstanding: Optional[int]
    trailing_pe: Optional[float]
    eps: Optional[float]
    price_timestamp: Optional[datetime]
    monthly_sales: list  # list[dict] with month_end, sales_amount
    quarterly: Optional[dict]  # revenue, net_profit, net_margin, etc.
    is_bank: bool = False
    is_insurance: bool = False
    is_holding: bool = False
    data_freshness: dict = None  # price_age, sales_age, quarterly_age
    source: str = ""

def fetch_stock_data(symbol: str, redis_client=None) -> StockData:
    """
    Fetch standardized stock data from TSETMC + Codal.ir.
    Uses Redis for caching with automatic fallback.
    """

    # 1. Check cache first
    cache_key = f"stock_data:{symbol}"
    if redis_client:
        cached = redis_client.get(cache_key)
        if cached:
            data = json.loads(cached)
            if datetime.now().timestamp() - data.get("_cached_at", 0) < 300:  # 5 min
                return StockData(**data)

    # 2. Fetch from TSETMC (cdn.tsetmc.com)
    tsetmc_url = f"https://cdn.tsetmc.com/api/Quote/AllData/{symbol}"
    headers = {"User-Agent": "BourseRadar/0.1 (+https://bourse-radar.ir)"}

    try:
        resp = requests.get(tsetmc_url, headers=headers, timeout=10)
        if resp.status_code == 429:
            # Rate limited — use stale cache
            if redis_client:
                cached = redis_client.get(cache_key)
                if cached: return StockData(**json.loads(cached))
            raise Exception("TSETMC rate limited and no cache available")
        resp.raise_for_status()
        tsetmc_data = resp.json().get("priceData", {})[0]
    except Exception as e:
        # Fallback to stale cache
        if redis_client:
            cached = redis_client.get(cache_key)
            if cached:
                data = json.loads(cached)
                data["is_stale"] = True
                return StockData(**data)
        raise

    # 3. Fetch monthly sales from Codal.ir
    monthly_sales = _fetch_monthly_sales(symbol)

    # 4. Fetch quarterly financials from Codal.ir
    quarterly = _fetch_quarterly_financials(symbol)

    # 5. Determine company type
    company_info = _fetch_company_profile(symbol)

    stock = StockData(
        symbol=symbol,
        name=tsetmc_data.get("lname", ""),
        name_en=tsetmc_data.get("lname_en", ""),
        sector=company_info.get("sector"),
        last_price=float(tsetmc_data.get("pl", 0)) or None,
        price_change=float(tsetmc_data.get("pc", 0)) or None,
        price_change_percent=float(tsetmc_data.get("po", 0)) or None,
        volume=int(tsetmc_data.get("vn", 0)) or None,
        value=float(tsetmc_data.get("qv", 0)) or None,
        market_cap=float(tsetmc_data.get("h_mv", 0)) or None,
        shares_outstanding=int(tsetmc_data.get("z", 0)) or None,
        trailing_pe=float(tsetmc_data.get("pe", 0)) or None,
        eps=float(tsetmc_data.get("eps", 0)) or None,
        price_timestamp=datetime.now(),
        monthly_sales=monthly_sales,
        quarterly=quarterly,
        is_bank=company_info.get("is_bank", False),
        is_insurance=company_info.get("is_insurance", False),
        is_holding=company_info.get("is_holding", False),
        data_freshness={
            "price_age_seconds": 0,
            "sales_age_days": (datetime.now() - monthly_sales[0]["fetched_at"]).days if monthly_sales else None,
            "quarterly_age_days": (datetime.now() - quarterly["fetched_at"]).days if quarterly else None,
        },
        source="tsetmc+codal",
    )

    # 6. Cache the result
    if redis_client:
        stock_dict = stock.__dict__
        stock_dict["_cached_at"] = datetime.now().timestamp()
        redis_client.setex(cache_key, 300, json.dumps(stock_dict, default=str))

    return stock
```

---

## 3. Forward P/E Estimation Engine

### Core Formula

```
Estimated_Annual_EPS = (Trailing_3M_Sales_Avg × 12 × Net_Margin) / Shares_Outstanding
Forward_P/E          = Current_Price / Estimated_Annual_EPS
```

**Full implementation:** [`forward_pe.py`](forward_pe.py) (runnable) and [`forward_pe.ts`](forward_pe.ts) (TypeScript reference).

### Algorithm Steps

#### Step 1: Collect Monthly Sales (Codal.ir فروش ماهانه) [citation:14]
- Fetch the **3 most recent** monthly sales reports for the symbol
- Sort by `month_end` date (most recent first)
- Compute the average: `trailing_3m_avg = sum(sales_i) / 3`
- If only 2 reports available, use those 2; if only 1, use that 1
- **Freshness gate:** If the most recent report's `month_end` is >75 days old (45 days + 30 days reporting delay), mark as non-calculable

#### Step 2: Annualize Revenue
- `annualized_sales = trailing_3m_avg × 12` (in millions IRR)
- This assumes sales are roughly uniform across months — a reasonable approximation for TSE non-seasonal businesses

#### Step 3: Determine Net Margin (Codal.ir فصلی) [citation:2]
Priority order:

1. **Adjusted quarterly net margin** (preferred):
   ```
   adjusted_net_profit = net_profit - extraordinary_income + extraordinary_expense
   net_margin = adjusted_net_profit / revenue
   ```
   - Extraordinary income (درآمد غیرعادی) is subtracted (one-time gains inflate the baseline)
   - Extraordinary expense (هزینه غیرعادی) is added back (one-time losses deflate the baseline)
   - **Stale threshold:** Quarterly `period_end` must be ≤180 days old

2. **Industry average margin** — precomputed from peer group
3. **Sector average margin** — precomputed from sector constituents
4. **Instrument-class default:**
   - Bank: 15% (net interest margin proxy)
   - Insurance: 8% (combined ratio complement)
   - Holding company: 5% (investment income)
   - General: 6%

#### Step 4: Calculate Estimated Annual EPS
```
estimated_eps = (annualized_sales_millions × 1_000_000 × net_margin) / shares_outstanding
```
- `annualized_sales_millions` is in millions of IRR → multiply by 1e6 to get IRR
- `shares_outstanding` is the total share count

**Guard:** If `estimated_eps ≤ 0` → return `forward_pe = null, confidence = non_calculable`

#### Step 5: Calculate Forward P/E
```
forward_pe = current_price / estimated_eps
```

#### Step 6: Confidence Scoring

| Level | Criteria | Score Range |
|---|---|---|
| **High** | Quarterly report ≤60 days + ≥3 monthly reports + margin from quarterly | 0.75–1.00 |
| **Medium** | Quarterly ≤120 days with ≥2 monthly reports, OR ≥3 monthly but quarterly stale | 0.40–0.75 |
| **Low** | Only 1–2 monthly reports, or quarterly >120 days, or margin from default | 0.20–0.40 |
| **Non-calculable** | No monthly sales data, or EPS ≤ 0, or shares unknown | 0.00 |

**Numeric score components:**
- Monthly reports: 3 reports = +0.35, 2 reports = +0.25, 1 report = +0.15
- Quarterly age: ≤60d = +0.35, ≤120d = +0.25, ≤180d = +0.15
- Margin source: quarterly = +0.25, industry_avg = +0.20, sector_avg = +0.15, default = +0.10

**Instrument-class adjustments:** Banks ×0.85, Insurance ×0.80, Holding ×0.75

### Edge Cases

| Instrument Class | Handling |
|---|---|
| **Banks** | Net margin post-provisioning is used. Banks report provisioning differently (مخازن صندوق تأمین). The formula is technically less precise because banks' "revenue" includes interest income, but net_margin / revenue is a reasonable proxy. Confidence score is reduced by 15%. |
| **Insurers** | Net margin is typically thin (~5-8%). Combined ratio would be ideal, but for the monthly-sales-based formula, net margin suffices. Confidence score is reduced by 20%. |
| **Holding companies** | Non-recurring gains/losses from subsidiary sales are stripped. Revenue may include non-operating income — use segment reporting if available. Confidence score is reduced by 25%. |
| **Non-recurring income** | Extraordinary items (درآمد/هزینه غیرعادی) are always stripped from net profit before margin calculation, per Codal.ir disclosure requirements [citation:13]. |

### Verified Example Output

```
Symbol:     خودرو (گروه خودرو سایپا)
Price:      1,850 IRR
3M Sales Avg: 49,166.67M IRR (annualized: 590,000M)
Net Margin:  5.13% (from quarterly Q3 FY1402, adjusted for 12M extraordinary income + 3M expense)
Shares:     2,500,000,000
Est. EPS:   12.11 IRR
Forward P/E: 152.76
Confidence:  HIGH (score: 0.95)
Disclaimer:  اعتمادسنجی: بالا — برآورد بر اساس 3 گزارش فروش ماهانه و صورت‌های مالی فصلی اخیر.
             ⚠️ این P/E Forward یک برآورد است، نه یک پیش‌بینی قیمت.
```

---

## 4. LLM Integration Layer

### System Prompt (Persian — enforced)

```persian
شما یک تحلیل‌گر مالی ارزش‌افزوده برای بازار سهام ایران هستید. وظیفه شما ارائه تجزیه و تحلیل‌های کمّی و
بدون پیش‌بینی قیمت است. هرگز نباید «بخر» یا «فروش» بگویید. فقط صرفاً داده‌ها را تعبیه کنید.

قوانین سخت‌گیرانه:
1. فقط از داده‌های ارائه‌شده در JSON استفاده کنید. اگر داده‌ای کافی نیست، صراحتاً بگویید.
2. هرگز عددی را حدس نزنید. اگر EPS Forward قابل محاسبه نیست، بگویید "قابل محاسبه نیست".
3. هرگز جهت‌گیری قیمتی پیش‌بینی نکنید. فقط می‌گویید چرا یک سهم در رتبه خاصی قرار دارد.
4. هموشنی داده‌ها را فاش کنید: اگر داده‌ها قدیمی‌اند یا حاشیه سود از منبع فرعی استخراج شده، این را بگویید.
5. تمام خروجی‌ها باید شامل بیانیه عدم‌اعتماد باشد: "این یک برآورد است، نه یک پیش‌بینی قیمت."
```

### LLM Input JSON Schema

```json
{
  "stock": {
    "symbol": "خودرو",
    "name": "گروه خودرو سایپا",
    "sector": "ساخت و ساز",
    "current_price": 1850.0,
    "trailing_pe": 8.2,
    "forward_pe": 152.76,
    "estimated_annual_eps": 12.11,
    "confidence": "high",
    "confidence_score": 0.95,
    "net_margin": 0.0513,
    "market_cap": 4625000000000,
    "daily_volume": 1250000000,
    "volume_value": 2312500000000,
    "price_change_24h": 45.0,
    "price_change_percent_24h": 2.5,
    "ranking_position": 7,
    "total_stocks_ranked": 420,
    "liquidity_percentile": 89.2,
    "market_cap_percentile": 91.5,
    "is_bank": false,
    "is_insurance": false,
    "is_holding_company": false,
    "data_freshness": {
      "price_age_seconds": 42,
      "sales_age_days": 3,
      "quarterly_age_days": 15
    },
    "disclaimer": "اعتمادسنجی: بالا — برآورد بر اساس 3 گزارش فروش ماهانه و صورت‌های مالی فصلی اخیر."
  }
}
```

### LLM Output JSON Schema (Zod-validated)

```typescript
const LlmNarrativeSchema = z.object({
  headline: z.string().max(140),           // Short title
  analysis: z.string().min(100).max(2000),  // 2–3 paragraphs in Persian
  quantitativeReasoning: z.string().max(500), // Why the ranking
  uncertaintyDisclosure: z.string().max(500), // Explicit caveats
  riskFactors: z.array(z.string().max(200)).max(5),       // ≤5 risk points
  positiveFactors: z.array(z.string().max(200)).max(5),   // ≤5 positive points
  disclaimer: z.string().max(300),         // Always includes "not investment advice"
  usage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
  }),
});
```

### Fallback Strategy

| LLM Failure Mode | Response |
|---|---|
| **OpenAI rate limit (429)** | Return rankings with `narrative: null`, `narrative_error: "LLM rate limited. Raw rankings provided."` |
| **OpenAI timeout (>30s)** | Same fallback |
| **Schema validation failure** | Retry once with temperature=0.0. If still fails, return `narrative: null` |
| **OpenAI API key missing** | Return `narrative: null` with `narrative_error: "LLM not configured."` |
| **All LLM symbols cached** | Return from `llm:narrative:{symbol}` Redis cache (10 min TTL) |

---

## 5. API Endpoints (Fastify)

### `GET /api/stocks`
List all symbols with Forward P/E, confidence, and sector.

**Query parameters:**
```
?page=1&limit=50&sector=بانکی&min_confidence=medium&has_forward_pe=true
```

**Response (200):**
```json
{
  "data": [
    {
      "symbol": "خودرو",
      "name": "گروه خودرو سایپا",
      "sector": "ساخت و ساز",
      "current_price": 1850.0,
      "trailing_pe": 8.2,
      "forward_pe": 152.76,
      "estimated_annual_eps": 12.11,
      "confidence": "high",
      "confidence_score": 0.95,
      "attractiveness_score": 60.59,
      "daily_volume": 1250000000,
      "market_cap": 4625000000000,
      "rank": 7,
      "price_change_percent": 2.5,
      "is_stale": false
    }
  ],
  "meta": { "total": 420, "page": 1, "limit": 50, "total_pages": 9 }
}
```

### `GET /api/stocks/{symbol}`
Detailed data for one symbol.

**Response (200):**
```json
{
  "symbol": "خودرو",
  "name": "گروه خودرو سایپا",
  "name_en": "Saipa Auto Group",
  "sector": "ساخت و ساز",
  "instrument_class": "سهام",
  "price": {
    "last": 1850.0,
    "open": 1840.0,
    "high": 1880.0,
    "low": 1820.0,
    "volume": 1250000000,
    "value": 2312500000000,
    "change": 45.0,
    "change_percent": 2.5,
    "timestamp": "2025-02-15T10:30:00Z",
    "is_stale": false
  },
  "fundamentals": {
    "trailing_pe": 8.2,
    "eps": 227.0,
    "book_value_per_share": 1540.0,
    "shares_outstanding": 2500000000,
    "market_cap": 4625000000000
  },
  "forward_pe": {
    "forward_pe": 152.76,
    "estimated_annual_eps": 12.11,
    "confidence": "high",
    "confidence_score": 0.95,
    "method": "monthly_sales_net_margin",
    "calculation_details": {
      "trailing_3m_sales_avg_millions_irr": 49166.67,
      "annualized_sales_millions_irr": 590000.0,
      "net_margin": 0.0513,
      "shares_outstanding": 2500000000
    },
    "sources": {
      "monthly_sales_reports": [
        {"month_end": "2025-01-30", "sales_millions": 48500, "source": "codal.ir"},
        {"month_end": "2025-01-01", "sales_millions": 51200, "source": "codal.ir"},
        {"month_end": "2024-12-01", "sales_millions": 47800, "source": "codal.ir"}
      ],
      "quarterly_fiscal_year": 1402,
      "quarterly_period": "Q3",
      "net_margin_source": "quarterly_adj",
      "price_source": "cdn.tsetmc.com"
    },
    "disclaimer": "⚠️ این P/E Forward یک برآورد است، نه یک پیش‌بینی قیمت."
  },
  "ranking": {
    "overall_rank": 7,
    "sector_rank": 3,
    "attractiveness_score": 60.59,
    "ranking_method": "inverse_forward_pe × 0.30 + confidence × 0.25 + liquidity × 0.25 + market_cap × 0.10 + stability × 0.10"
  }
}
```

**Response (non-calculable case):**
```json
{
  "symbol": "اگهان",
  "name": "شرکت اگهان",
  "forward_pe": {
    "forward_pe": null,
    "confidence": "non_calculable",
    "confidence_score": 0.0,
    "disclaimer": "تعداد سهام ثبت‌شده در دسترس نیست. P/E Forward: غیرقابل محاسبه."
  }
}
```

### `GET /api/rankings`
Ranked list with filters.

**Query parameters:**
```
?min_confidence=medium&max_forward_pe=30&sector=فلزات&limit=100&sort=attractiveness_desc
```

**Response (200):**
```json
{
  "data": [
    {
      "symbol": "فولاد",
      "name": "شرکت فولاد خوزستان",
      "forward_pe": 12.3,
      "confidence": "high",
      "confidence_score": 0.92,
      "attractiveness_score": 87.34,
      "sector": "فلزات و معادن",
      "rank": 1,
      "daily_volume": 8500000000
    }
  ],
  "meta": { "total": 156, "generated_at": "2025-02-15T10:30:00Z" }
}
```

### `GET /api/suggestions`
LLM-generated narrative suggestions.

**Query parameters:**
```
?top_n=10&min_confidence=medium
```

**Response (200):**
```json
{
  "generated_at": "2025-02-15T10:30:00Z",
  "model": "gpt-4o-2024-08-06",
  "data": [
    {
      "symbol": "فولاد",
      "headline": "سهام فولاد خوزستان با P/E Forward 12.3 و اعتمادسنجی بالا رتبه اول",
      "analysis": "بر اساس ۳ گزارش فروش ماهانه و صورت مالی فصلی اخیر، این سهم نشانگر...",
      "quantitative_reasoning": "P/E Forward 12.3 درصد پایین‌تر از میانگین بخش فلزات (28.5) است.",
      "uncertainty_disclosure": "حاشیه سود از صورت مالی فصلی Q3/1402 به‌روز است.",
      "risk_factors": ["وابستگی به قیمت جهانی فولاد", "ریسک ارزی"],
      "positive_factors": ["حاشیه سود 12.3% بالا", "نقدشوندگی بالا"],
      "disclaimer": "این تحلیل جایگزین مشاوره سرمایه‌گذاری نمی‌شود."
    }
  ]
}
```

### Rate Limiting (Fastify `@fastify/rate-limit` + Redis)

| Route Group | Rate Limit | Scope |
|---|---|---|
| All routes | 100 req/min | Per IP (global) |
| `/api/stocks*` | 120 req/min | Per IP |
| `/api/rankings` | 60 req/min | Per IP |
| `/api/suggestions` | 30 req/min | Per IP (expensive LLM) |
| With API key | 1000 req/min | Per API key |

**Authentication:** API key via `X-API-Key` header. No user accounts in v1. Keys distributed manually to partners. Rate-limit by key when present.

```typescript
// fastify-rate-limit with Redis store
await server.register(fastifyRateLimit, {
  max: config.rateLimit.global,
  timeWindow: "60s",
  redis: redisClient,   // shared IP-based bucket
  keyPrefix: "rate_limit:",
});
```

---

## 6. Frontend (RTL Persian Dashboard)

### Framework: Next.js 14 + React + Tailwind RTL +shadcn/ui

The backend serves all data via REST API. The frontend is a separate Next.js app (not in scope for this backend blueprint) that consumes these endpoints.

**Key screens** (reference only — frontend is a separate repo):

| Screen | Data Source |
|---|---|
| **Market Overview** | `GET /api/stocks?limit=10` + sector aggregates |
| **Ranking Table** | `GET /api/rankings` (sortable, filterable) |
| **Stock Detail** | `GET /api/stocks/{symbol}` |
| **AI Suggestions** | `GET /api/suggestions` |

### Data Visualization (frontend concerns)
- **P/E Distribution Histogram** — bins: <10, 10–20, 20–50, 50–100, >100
- **Sector Comparison Bar Chart** — median Forward P/E by sector
- **Confidence Bubble Chart** — x-axis: Forward P/E, y-axis: confidence score, size: market cap
- **Data Freshness Badge** — green (<5 min), yellow (<1 hour), red (>1 hour)

### Loading States
- Skeleton tables during data fetch
- Per-row "stale" badge if `price.is_stale` or `data_freshness.*` exceeds threshold
- "Non-calculable" label in P/E Forward column when `confidence = non_calculable`

---

## 7. Critical Warnings & Disclaimers

### ⚠️ Legal Disclaimer

**Bourse Radar provides data-driven quantitative rankings ONLY. It does NOT provide buy/sell/hold investment advice, signals, or recommendations.** All outputs are analytical tools for information purposes. Users bear full responsibility for investment decisions. Consult a licensed financial advisor.

### ⚠️ Technical Risks [citation:4]

1. **TSETMC unofficial APIs may break without notice.** The `cdn.tsetmc.com` endpoints are not documented or officially supported. They may change, return 403, or stop working at any time. Always implement graceful degradation.
2. **Codal.ir has no public API.** Web scraping is fragile and subject to anti-bot measures (CAPTCHAs, IP bans).
3. **Iranian fiscal calendar (Jalali/Nowruz).** All dates must be converted between Jalali (1402/...) and Gregorian. Use the `jdatetime` library (Python) or `jalali` npm package.
4. **Data synchronization window.** TSETMC prices are ~15-minute delayed for free-tier endpoints. Real-time requires paid subscriptions.

### ⚠️ Financial Risks [citation:14]

1. **Forward P/E is an ESTIMATE, not a guarantee.** The formula annualizes monthly sales × an assumed net margin. Real earnings may differ significantly due to seasonality, margin compression, or non-recurring items.
2. **EPS forecasts are not mandatory since 2018.** Many TSE companies do not publish forward-looking EPS guidance. This means confidence will be `low` or `non_calculable` for many stocks.
3. **Monthly sales ≠ annual performance.** A company with high monthly sales may have one-time costs, inventory write-downs, or margin erosion not visible in monthly reports.
4. **Holding companies and banks have structurally different financials.** The margin-based formula is less reliable for these instrument classes. Confidence scores are explicitly reduced.

### ⚠️ Data Quality Warnings

1. **`--non_calculable` is the correct answer.** When monthly sales data is missing, quarterly financials are stale, or shares outstanding is unknown, the system returns `forward_pe: null, confidence: "non_calculable"`. This is a feature, not a bug.
2. **Extraordinary items are stripped.** One-time gains (درآمد غیرعادی) and losses (هزینه غیرعادی) are removed from net profit before margin calculation to avoid inflated EPS estimates.
3. **Industry/sector margin fallbacks introduce variance.** When a company's quarterly margin is unavailable, industry averages may not reflect the specific company's cost structure.
4. **Currency:** All monetary values are in Iranian Rial (IRR). Hyperinflation means nominal values change dramatically quarter-over-quarter. Real (inflation-adjusted) analysis is beyond this scope.

---

## Appendix: SQL Schema (PostgreSQL)

```sql
-- Stocks (reference data)
CREATE TABLE stocks (
    symbol          TEXT PRIMARY KEY,                          -- e.g. 'خودرو'
    name            TEXT NOT NULL,
    name_en         TEXT,
    sector          TEXT,
    isin            TEXT UNIQUE,
    shares_outstanding BIGINT,
    is_bank         BOOLEAN DEFAULT FALSE,
    is_insurance    BOOLEAN DEFAULT FALSE,
    is_holding      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Real-time prices (time-series)
CREATE TABLE prices (
    symbol       TEXT REFERENCES stocks(symbol),
    timestamp    TIMESTAMPTZ,
    last_price   NUMERIC,
    open_price   NUMERIC,
    high_price   NUMERIC,
    low_price    NUMERIC,
    volume       BIGINT,
    value        NUMERIC,
    PRIMARY KEY (symbol, timestamp)
);

-- Monthly sales (Codal.ir فروش ماهانه) [citation:14]
CREATE TABLE monthly_sales (
    symbol         TEXT REFERENCES stocks(symbol),
    month_end      DATE NOT NULL,
    sales_amount   NUMERIC,                  -- میلیون ریال
    is_estimated   BOOLEAN DEFAULT FALSE,    -- برآوردی vs. واقعی
    source_url     TEXT,
    fetched_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (symbol, month_end)
);

-- Quarterly financials (Codal.ir) [citation:2]
CREATE TABLE quarterly_financials (
    symbol         TEXT REFERENCES stocks(symbol),
    fiscal_year    INTEGER,
    quarter        INTEGER,
    period_start   DATE,
    period_end     DATE,
    revenue        NUMERIC,           -- میلیارد ریال
    net_profit     NUMERIC,
    net_margin     NUMERIC,            -- fraction
    extraordinary_income NUMERIC,
    extraordinary_expense NUMERIC,
    shares_outstanding BIGINT,
    source_url     TEXT,
    fetched_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (symbol, fiscal_year, quarter)
);

-- Forward P/E calculations (snapshot table — append-only)
CREATE TABLE forward_pe (
    symbol             TEXT REFERENCES stocks(symbol),
    calculated_at      TIMESTAMPTZ DEFAULT NOW(),
    estimated_annual_eps NUMERIC,
    forward_pe         NUMERIC,
    confidence         TEXT,           -- 'high' | 'medium' | 'low' | 'non_calculable'
    confidence_score   NUMERIC,        -- 0.0 – 1.0
    method             TEXT,
    margin_source      TEXT,
    margin_used        NUMERIC,
    sales_count        INTEGER,
    disclaimer         TEXT,
    calculation_json   JSONB,
    PRIMARY KEY (symbol, calculated_at)
);

-- Latest Forward P/E per symbol (for fast API queries)
CREATE INDEX idx_forward_pe_latest ON forward_pe (symbol, calculated_at DESC);

-- Materialized ranking view (refreshed every 15 min)
CREATE MATERIALIZED VIEW stock_rankings AS
SELECT
    s.symbol,
    s.name,
    s.sector,
    p.last_price,
    fp.forward_pe,
    fp.estimated_annual_eps,
    fp.confidence,
    fp.confidence_score,
    fp.calculation_json,
    PERCENT_RANK() OVER (ORDER BY fp.forward_pe ASC) * 100 AS pe_percentile,
    CUME_DIST() OVER (PARTITION BY s.sector ORDER BY p.volume DESC) * 100 AS liquidity_pct,
    -- Attractiveness score formula:
    -- inverse_pe * 0.30 + confidence * 0.25 + liquidity * 0.25 + mc * 0.10 + stability * 0.10
    ROUND(
        COALESCE(1.0 / (1.0 + fp.forward_pe / 15.0), 0) * 0.30
      + COALESCE(fp.confidence_score, 0) * 0.25
      + LEAST(LOG(10, GREATEST(p.volume, 1)) / 10.0, 1.0) * 0.25
      + 0.10
      + 0.10
    , 2) AS attractiveness_score
FROM stocks s
JOIN LATERAL (
    SELECT last_price, volume, timestamp
    FROM prices
    WHERE symbol = s.symbol
    ORDER BY timestamp DESC LIMIT 1
) p ON TRUE
LEFT JOIN LATERAL (
    SELECT forward_pe, estimated_annual_eps, confidence, confidence_score,
           calculation_json, calculated_at
    FROM forward_pe
    WHERE symbol = s.symbol
    ORDER BY calculated_at DESC LIMIT 1
) fp ON TRUE
WHERE fp.forward_pe IS NOT NULL AND fp.confidence != 'non_calculable';

CREATE INDEX idx_stock_rankings_sector ON stock_rankings(sector);
CREATE INDEX idx_stock_rankings_score ON stock_rankings(attractiveness_score DESC);
CREATE INDEX idx_stock_rankings_pe ON stock_rankings(forward_pe);
```

---

## Appendix: Cron Job Schedules

| Job | Schedule | Purpose |
|---|---|---|
| `ingest-prices` | Every 5 min (market hours) | TSETMC price + volume scraping |
| `ingest-symbols` | Daily 6:00 AM | Refresh symbol list + sectors |
| `ingest-monthly-sales` | Daily 7:00 AM | Codal.ir monthly sales reports |
| `ingest-quarterly-financials` | Daily 8:00 AM | Codal.ir quarterly P&L |
| `compute-forward-pe` | Daily 9:00 AM + every 4 hours | Re-estimate Forward P/E for all stocks |
| `compute-rankings` | Daily 9:15 AM + every 4 hours | Refresh materialized ranking view |
| `generate-narratives` | Daily 10:00 AM | LLM narrative for top-20 stocks |

**Market hours (TSE):** Sunday 9:00 AM – Thursday 12:30 PM (IRST). Jobs are disabled outside market hours to conserve resources.

---

*This blueprint is maintained at `F:\project\bourse`. The runnable Python implementation is in [`forward_pe.py`](forward_pe.py) and the TypeScript reference is in [`forward_pe.ts`](forward_pe.ts).*
