/**
 * Codal.ir Scraper
 *   - Monthly sales reports (گزارش فعالیت ماهانه, LetterType 58)
 *   - Quarterly income statements (صورت سود و زیان, LetterType 6)
 *
 * Monthly reports embed `var datasource = {...}` with a `cells` array.
 * Quarterly reports render the income statement as plain HTML after an
 * ASP.NET postback that selects "صورت سود و زیان" from `#ctl00_ddlTable`.
 * A plain fetch returns the shell page (نظر حسابرس) with no table, so
 * quarterly income statements require a real browser (Playwright).
 *
 * All dates from Codal use Persian digits (۰-۹); we normalize to ASCII.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { jalaliToGregorian, toIsoDate } from "#utils/jalali";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

const CODAL_SEARCH = "https://search.codal.ir/api/search";
const CODAL_BASE = "https://www.codal.ir";

const H = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
  Origin: "https://codal.ir",
  Referer: "https://codal.ir/",
};

// ═══════════════════════════════════════════════════════════════
// Global rate limiting
// ═══════════════════════════════════════════════════════════════
// Codal throttles aggressively and answers 429 with a useless body
// ("The custom error module does not recognize this error"). A single
// archive backfill fires 20 paginated searches plus one fetch per
// report, which reliably trips it.
//
// This is a token bucket with capacity 1: every call takes a minimum
// slot, and the next call cannot start until minIntervalMs has passed
// since the previous one STARTED. Calls are serialized, so concurrent
// ingest workers queue instead of bursting.
//
// 429/5xx are retried with exponential backoff + jitter, honouring
// `Retry-After` when Codal sends it.

/**
 * Errors returned during Codal operations.
 * Provides structured error handling with context for debugging and retry logic.
 */
export class CodalHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly timestamp: number;
  readonly source: string;

  constructor(
    status: number,
    message: string,
    retryAfterMs: number | null = null,
    source: string = "unknown",
  ) {
    super(message);
    this.name = "CodalHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.timestamp = Date.now();
    this.source = source;
  }

  /** Get human-friendly error message with context */
  getHumanMessage(): string {
    const timeStr = new Date(this.timestamp).toLocaleTimeString();
    if (this.status >= 429) {
      return `Codal rate limited at ${timeStr}. ${this.retryAfterMs ? `Try again in ${this.retryAfterMs / 1000}s` : 'Wait before retrying'}.`;
    }
    return `Codal {${this.source}} failed at ${timeStr}: ${this.message} (HTTP ${this.status})`;
  }

  /** Check if this error should trigger a circuit breaker */
  shouldCircuitBreak(): boolean {
    return this.status >= 429 && this.retryAfterMs === null;
  }

  /** Check if this error is retriable */
  get isRetriable(): boolean {
    return this.status >= 429 || this.status >= 500;
  }
}

/**
 * Temporary blocking issues during scraping operations.
 * Some errors like rate limits, CAPTCHA, or network disconnections should not cause full failures.
 */
export class TemporaryScraperError extends Error {
  readonly reason: string;
  readonly timestamp: number;

  constructor(
    message: string,
    _retryAfterMs: number | null = null,
    reason: string = "temporary",
  ) {
    super(message);
    this.name = "TemporaryScraperError";
    this.reason = reason;
    this.timestamp = Date.now();
  }

  getHumanMessage(): string {
    return `${this.reason}: ${this.message}`;
  }

  get shouldRetry(): boolean {
    return true;
  }
}

/**
 * EPERM error for browser launch failures on Windows.
 */
export class BrowserLaunchError extends TemporaryScraperError {
  constructor(message: string) {
    super(message, null, "browser launch failure");
    this.name = "BrowserLaunchError";
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared circuit breaker across ALL Codal traffic to prevent IP bans.
 *
 * # Purpose
 * Codal bans by IP address, affecting both search and report hosts. This
 * circuit breaker prevents continued requests after detecting a ban.
 *
 * # How It Works
 * - Monitors HTTP 429 (rate limit) responses within a rolling window
 * - After THRESHOLD throttles (default 6), stops all Codal requests
 * - Maintains cooldown period (default 120s) to let temporary bans expire
 * - Auto-resumes after cooldown, adjusting throttle detection sensitivity
 *
 * # Configuration
 * @property {number} THRESHOLD = 6 - Throttles before opening circuit
 * @property {number} WINDOW_MS = 60_000 - Rolling window for throttle counting
 * @property {number} COOLDOWN_MS = 120_000 - Silence duration when circuit opens
 *
 * @see RateLimiter - Rate limiter for adding artificial delays between requests
 */
const THRESHOLD = 6; // throttles inside the window before we stop
const WINDOW_MS = 60_000; // rolling window for counting throttles
const COOLDOWN_MS = 120_000; // how long we stay silent once tripped

let throttleStamps: number[] = [];
let breakerOpenUntil = 0;

function parseRetryAfterHeader(raw: string | undefined): number | null {
  if (!raw) return null;

  const seconds = Number(raw);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(raw);

  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return null;
}

function looksLikeCaptcha(html: string): boolean {
  return /captcha|verify you are human|access denied|درخواست غیرمجاز|عبارت امنیتی/i.test(
    html.slice(0, 20_000),
  );
}

async function codalGetText(
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  const context = await getCodalContext();

  const response = await context.request.get(url, {
    headers,
    timeout: 60_000,
  });

  const body = await response.text();
  const status = response.status();

  // A challenge can be returned with HTTP 200, 403, or 429.
  if (status === 429 || status === 403 || looksLikeCaptcha(body)) {
    await pauseForManualCaptcha(url);

    // Use 429 to let the existing RateLimiter retry after the pause.
    throw new CodalHttpError(
      429,
      `Codal challenge encountered (HTTP ${status}): ${url}`,
      parseRetryAfterHeader(response.headers()["retry-after"]),
    );
  }

  if (!response.ok()) {
    throw new CodalHttpError(
      status,
      `Codal HTTP ${status}: ${url}`,
      parseRetryAfterHeader(response.headers()["retry-after"]),
    );
  }

  return body;
}

function noteThrottle(retryAfterMs: number | null = null): void {
  const now = Date.now();
  throttleStamps = throttleStamps.filter((t) => now - t < WINDOW_MS);
  throttleStamps.push(now);
  if (throttleStamps.length >= THRESHOLD) {
    const until = now + Math.max(COOLDOWN_MS, retryAfterMs ?? 0);
    breakerOpenUntil = Math.max(breakerOpenUntil, until);
    throttleStamps = [];
    console.warn(
      `  [codal] circuit OPEN — pausing all Codal traffic for ${Math.ceil(
        (breakerOpenUntil - now) / 1000,
      )}s after ${THRESHOLD} throttles`,
    );
  }
}

function noteSuccess(): void {
  // A clean call is evidence the pressure has eased.
  if (throttleStamps.length) throttleStamps.pop();
}

/** True while we are deliberately silent so Codal can lift the ban. */
export function isCodalCoolingDown(): boolean {
  return Date.now() < breakerOpenUntil;
}

/** Milliseconds left on the cooldown, for surfacing in admin responses. */
export function codalCooldownRemainingMs(): number {
  return Math.max(0, breakerOpenUntil - Date.now());
}

/** Human-readable one-liner for logs and the admin ingest response. */
export function codalThrottleStatus(): string {
  const left = codalCooldownRemainingMs();
  if (left > 0) {
    return `cooling down ${Math.ceil(left / 1000)}s after ${THRESHOLD} throttles`;
  }
  return throttleStamps.length
    ? `throttled ${throttleStamps.length}/${THRESHOLD}`
    : "ok";
}

/**
 * Transient socket-level failures. These come back as raw Playwright/Node
 * errors with NO HTTP status (status 0), so the throttling branches above
 * never see them — without this check a single `read ECONNRESET` fails the
 * whole letter permanently even though re-fetching it usually works.
 */
function isTransientNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ENETUNREACH|socket hang up|ERR_NETWORK|ERR_INTERNET_DISCONNECTED|net::ERR_(EMPTY_RESPONSE|CONNECTION_(RESET|CLOSED|REFUSED)|TIMED_OUT)|Timeout .*exceeded/i.test(
    msg,
  );
}

class RateLimiter {
  /** Tail of the serialization chain. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Earliest time the next request may start. */
  private nextSlotAt = 0;
  private intervalMs: number;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;

  constructor(minIntervalMs: number, maxAttempts = 3) {
    this.minIntervalMs = minIntervalMs;
    this.intervalMs = minIntervalMs;
    this.maxAttempts = maxAttempts;
  }

  /**
   * Run `fn` under the bucket, retrying rate-limit / server errors.
   * `fn` must throw {@link CodalHttpError} for a retryable status.
   *
   * While the shared breaker is open this waits it out instead of firing
   * more traffic into an active ban.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(
      () => this.execute(fn),
      () => this.execute(fn),
    );
    // Keep the chain alive regardless of this call's outcome.
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      // Respect an open breaker before spending a slot.
      const cooling = codalCooldownRemainingMs();
      if (cooling > 0) {
        if (attempt === 1) {
          console.warn(
            `  [codal] breaker open — waiting ${Math.ceil(cooling / 1000)}s before any request`,
          );
          await sleep(cooling);
        }
        const waitFor = this.nextSlotAt - Date.now();
        if (waitFor > 0) await sleep(waitFor);
      } else {
        const waitFor = this.nextSlotAt - Date.now();
        if (waitFor > 0) await sleep(waitFor);
      }
      this.nextSlotAt = Date.now() + this.intervalMs;

      try {
        const out = await fn();
        noteSuccess();
        // Back off toward the floor once we are getting through again.
        this.intervalMs = Math.max(this.minIntervalMs, this.intervalMs * 0.9);
        return out;
      } catch (e) {
        const status = e instanceof CodalHttpError ? e.status : 0;
        const retryAfter = e instanceof CodalHttpError ? e.retryAfterMs : null;
        const isThrottle = status === 429 || (status >= 500 && status < 600);
        const transient = !isThrottle && isTransientNetworkError(e);
        const retryable = isThrottle || transient;
        if (!retryable) throw e;

        // The breaker counts REAL throttles. A socket reset is the host
        // hanging up mid-request, not a rate limit — counting it would open
        // the breaker and silence us for 2 minutes for no reason.
        if (isThrottle) {
          noteThrottle(retryAfter);
        }
        // Widen the gap permanently-ish while the host is unhappy.
        this.intervalMs = Math.min(
          5_000,
          Math.max(
            this.minIntervalMs,
            this.intervalMs * (isThrottle ? 2 : 1.5),
          ),
        );

        if (attempt >= this.maxAttempts) throw e;

        // Exponential backoff + jitter, but never shorter than the server's ask.
        const backoff = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
        const jitter = backoff * 0.25 * Math.random();
        const wait =
          retryAfter != null
            ? Math.max(backoff + jitter, retryAfter)
            : backoff + jitter;

        console.warn(
          `  [codal] ${status ? `HTTP ${status}` : `network error (${e instanceof Error ? e.message.split("\n")[0] : e})`} — retry ${attempt}/${this.maxAttempts} in ${Math.round(wait)}ms (interval now ${this.intervalMs}ms)`,
        );
        await sleep(wait);
      }
    }
  }
}

/**
 * Search API (`search.codal.ir`) — the endpoint that returns 429.
 * Both limiters share one breaker, because the ban is per-IP, not per-host.
 * 1200ms is the polite floor for a single archive backfill.
 */
const searchLimiter = new RateLimiter(1200);
/** Report pages (`www.codal.ir`) — different host, same courtesy. */
const reportLimiter = new RateLimiter(1200);

// ═══════════════════════════════════════════════════════════════
// Browser singleton — for quarterly income statements only
// ═══════════════════════════════════════════════════════════════

/**
 * Set when a launch fails in a way that will not fix itself on retry
 * (e.g. `spawn EPERM` from a sandbox). Without this, every letter in a
 * backfill retries a doomed launch and floods the log with the same error.
 */

// ─────────────────────────────────────────────────────────────
// Shared browser + context for all Codal requests
// ─────────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;
let browserLaunch: Promise<Browser> | null = null;
let browserUnavailable: string | null = null;

let codalContext: BrowserContext | null = null;
let captchaPage: Page | null = null;
let captchaPause: Promise<void> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) return browserInstance;
  if (browserUnavailable) throw new Error(browserUnavailable);
  if (browserLaunch) return browserLaunch;

  browserLaunch = chromium
    .launch({
      headless: false, // Visible Chrome so you can solve CAPTCHA manually
      channel: "chrome",
    })
    .then((browser) => {
      browserInstance = browser;
      browserUnavailable = null;

      browser.on("disconnected", () => {
        browserInstance = null;
        codalContext = null;
        captchaPage = null;
      });

      return browser;
    })
    .finally(() => {
      browserLaunch = null;
    });

  try {
    return await browserLaunch;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      /spawn (EPERM|ENOENT|EACCES)|not found|access is denied/i.test(message)
    ) {
      browserUnavailable = `Browser unavailable: ${message.split("\n")[0]}`;
    }

    browserInstance = null;
    throw error;
  }
}

async function getCodalContext(): Promise<BrowserContext> {
  if (codalContext) {
    return codalContext;
  }

  const browser = await getBrowser();

  codalContext = await browser.newContext({
    userAgent: UA,
    locale: "fa-IR",
    extraHTTPHeaders: {
      "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
    },
  });

  return codalContext;
}

/**
 * After a manual CAPTCHA solve, verify the clearance cookie actually landed
 * on the host we need to query. Codal's WAF frequently sets the challenge
 * cookie on `codal.ir` (or on the browser's default partition), but the API
 * lives at `search.codal.ir`. Playwright's `context.request.get` will not
 * carry a cookie that isn't scoped to the request's host, so the next call
 * looks like a fresh client and re-trips the WAF.
 *
 * We check both hosts explicitly and, if the API host is missing the cookie,
 * we visit the API host in a real page so the browser itself receives and
 * stores it before we retry via `context.request`.
 */
async function ensureClearanceCookie(apiUrl: string): Promise<void> {
  const context = await getCodalContext();
  const apiHost = new URL(apiUrl).host; // e.g. search.codal.ir

  const readCookies = async (host: string) => {
    try {
      return await context.cookies(`https://${host}`);
    } catch {
      return [];
    }
  };

  const apiCookies = await readCookies(apiHost);
  const baseCookies = await readCookies("www.codal.ir");
  const rootCookies = await readCookies("codal.ir");

  // Heuristic: Codal's clearance cookies are typically named with a
  // challenge-ish prefix. We accept any non-session-looking cookie as
  // evidence the WAF let us through.
  const hasClearance = (cookies: Awaited<ReturnType<typeof readCookies>>) =>
    cookies.some((c) => {
      const n = c.name.toLowerCase();
      return (
        n.includes("captcha") ||
        n.includes("clearance") ||
        n.includes("cf_") ||
        n.includes("incap") ||
        n.includes("codal") ||
        n.includes("asp") // ASP.NET session cookies also indicate a real visit
      );
    });

  if (hasClearance(apiCookies)) {
    console.log(
      `[codal] clearance cookie present on ${apiHost} (${apiCookies.length} cookies)`,
    );
    return;
  }

  console.warn(
    `[codal] no clearance cookie on ${apiHost} — ` +
      `base=${baseCookies.length} root=${rootCookies.length}. ` +
      `Visiting ${apiHost} in the browser to collect it.`,
  );

  // Visit the API host in a real page so the browser receives Set-Cookie.
  const page = await context.newPage();
  try {
    await page.goto(`https://${apiHost}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // Give the WAF a moment to issue the cookie.
    await page.waitForTimeout(1500);
  } catch (e) {
    console.warn(
      `[codal] visit to ${apiHost} failed:`,
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    await page.close().catch(() => undefined);
  }

  const after = await readCookies(apiHost);
  if (hasClearance(after)) {
    console.log(
      `[codal] clearance cookie acquired on ${apiHost} (${after.length} cookies)`,
    );
  } else {
    console.warn(
      `[codal] still no clearance cookie on ${apiHost} after visit ` +
        `(${after.length} cookies). The retry may still hit the WAF.`,
    );
  }
}

/**
 * Open the Codal homepage in visible Chrome and wait for manual confirmation.
 * Requests are paused until you press Enter in the terminal.
 *
 * We deliberately do NOT pass the failing API URL to the browser. Codal's
 * WAF only renders a solvable challenge on the site root; hitting the API
 * path directly just returns a 403/ASP.NET error that cannot be solved.
 *
 * After the solve we verify the clearance cookie is scoped to the API host,
 * not just to codal.ir — see {@link ensureClearanceCookie}.
 */
const CODAL_HOME = "https://www.codal.ir/";

async function pauseForManualCaptcha(apiUrl: string): Promise<void> {
  if (captchaPause) {
    return captchaPause;
  }

  captchaPause = (async () => {
    const context = await getCodalContext();

    if (!captchaPage || captchaPage.isClosed()) {
      captchaPage = await context.newPage();
    }

    console.warn("\n[codal] CAPTCHA / access challenge detected.");
    console.warn("[codal] Requests are paused.");
    console.warn(`[codal] Failed URL: ${apiUrl}`);
    console.warn(`[codal] Opening homepage for solving: ${CODAL_HOME}`);

    await captchaPage
      .goto(CODAL_HOME, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      .catch((error: unknown) => {
        console.warn(
          "[codal] Page navigation warning:",
          error instanceof Error ? error.message : String(error),
        );
      });

    const terminal = createInterface({
      input: stdin,
      output: stdout,
    });

    try {
      await terminal.question(
        "\nSolve the challenge in Chrome (on codal.ir). When finished, press Enter here to retry...\n",
      );
    } finally {
      terminal.close();
    }

    // ── Verify the clearance cookie landed on the API host ──
    await ensureClearanceCookie(apiUrl);

    console.log("[codal] Retrying the interrupted request.");
  })().finally(() => {
    captchaPause = null;
  });

  return captchaPause;
}

export async function closeBrowser(): Promise<void> {
  if (captchaPage && !captchaPage.isClosed()) {
    await captchaPage.close().catch(() => undefined);
  }

  captchaPage = null;

  if (codalContext) {
    await codalContext.close().catch(() => undefined);
    codalContext = null;
  }

  if (browserInstance) {
    await browserInstance.close().catch(() => undefined);
    browserInstance = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CodalLetter {
  tracingNo: number;
  symbol: string;
  companyName: string;
  title: string;
  letterCode: string;
  publishDateTime: string;
  url: string;
  hasHtml: boolean;
  hasPdf: boolean;
  hasExcel: boolean;
}

export interface QuarterlyFinancials {
  periodEnds: string[];
  /** Cumulative duration in months per column (3/6/9/12); 0 = unknown. */
  durationMonths: number[];
  revenues: Array<number | null>;
  netProfits: Array<number | null>;
  eps: Array<number | null>;
  capitals: Array<number | null>;
  margins: Array<number | null>;
  latestMargin: number | null;
  latestPeriod: string | null;
  sharesOutstanding: number | null;
}

export interface QuarterlyResult {
  latestPeriod: string | null;
  latestMargin: number | null;
  financials: QuarterlyFinancials;
  reportUrl: string;
}

export interface MonthlySalesRow {
  rowCode: number;
  label: string;
  qtyPeriod: number | null;
  valuePeriod: number | null;
  qtyYtd: number | null;
  valueYtd: number | null;
  qtyPriorYtd: number | null;
  valuePriorYtd: number | null;
  rowTypeName: string;
}

export interface MonthlyReportResult {
  periodEnd: { jy: number; jm: number; jd: number };
  amount: number;
  reportUrl: string;
  detail: ReturnType<typeof extractMonthlyReport> | null;
}

interface CellRecord {
  metaTableId: number;
  metaTableCode: number;
  address: string;
  rowCode: number;
  rowSequence: number;
  columnCode: number;
  rowTypeName: string;
  value: string;
  formula?: string;
}

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

/** Persian/Arabic-Indic digits → ASCII */
export function toAsciiDigits(s: string): string {
  return s
    .replace(/[\u06F0-\u06F9]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0x06f0 + 48),
    )
    .replace(/[\u0660-\u0669]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0x0660 + 48),
    );
}

/** Parse "منتهی به ۱۴۰۵/۰۵/۳۱" from a title. */
export function extractJalaliPeriodEnd(
  title: string,
): { jy: number; jm: number; jd: number } | null {
  const clean = toAsciiDigits(title);
  const m = clean.match(/منتهی\s+به\s+(\d{4})\/(\d{2})\/(\d{2})/);
  if (!m) {
    return null;
  }

  const [_, jyStr, jmStr, jdStr] = m;
  // Use non-null assertions as regex guarantees these are strings
  const jy = parseInt(jyStr!, 10);
  const jm = parseInt(jmStr!, 10);
  const jd = parseInt(jdStr!, 10);

  // Validate date components to prevent invalid dates
  if (jy < 1300 || jy > 1500 || jm < 1 || jm > 12 || jd < 1 || jd > 31) {
    return null;
  }

  return { jy, jm, jd };
}

// ═══════════════════════════════════════════════════════════════
// Search API
// ═══════════════════════════════════════════════════════════════

const DEFAULT_SEARCH = {
  TracingNo: "-1",
  LetterCode: null,
  LetterType: "-1",
  FromDate: null,
  ToDate: null,
  Isic: null,
  AuditorRef: "-1",
  YearEndToDate: null,
  PageNumber: "1",
  Audited: "true",
  NotAudited: "true",
  IsNotAudited: "false",
  Childs: "true",
  Mains: "true",
  Publisher: "false",
  CompanyState: "-1",
  ReportingType: "-1",
  name: "",
  Length: "-1",
  Category: "-1",
  CompanyType: "-1",
  Consolidatable: "true",
  NotConsolidatable: "true",
};

export async function searchLetters(
  symbol: string,
  opts: Record<string, unknown> = {},
): Promise<CodalLetter[]> {
  const model: Record<string, unknown> = {
    Symbol: symbol,
    ...DEFAULT_SEARCH,
    ...opts,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(model)) {
    if (v === null || v === undefined || v === "") continue;
    q.append(k, String(v));
  }
  const url = `${CODAL_SEARCH}/v2/q?${q.toString()}`;

  return searchLimiter.run(async () => {
    const body = await codalGetText(url, H);

    const data = JSON.parse(body) as {
      Letters?: Record<string, unknown>[];
    };

    return (data.Letters ?? []).map((letter) => ({
      tracingNo: Number(letter.TracingNo ?? 0),
      symbol: String(letter.Symbol ?? ""),
      companyName: String(letter.CompanyName ?? ""),
      title: String(letter.Title ?? ""),
      letterCode: String(letter.LetterCode ?? ""),
      publishDateTime: String(letter.PublishDateTime ?? ""),
      url: String(letter.Url ?? ""),
      hasHtml: Boolean(letter.HasHtml),
      hasPdf: Boolean(letter.HasPdf),
      hasExcel: Boolean(letter.HasExcel),
    }));
  });
}

export function filterMonthlySalesLetters(
  letters: CodalLetter[],
): CodalLetter[] {
  return letters.filter(
    (l) => l.title.includes("فعالیت ماهانه") && !l.title.includes("اصلاحیه"),
  );
}

// ═══════════════════════════════════════════════════════════════
// Monthly report parsing (datasource JSON)
// ═══════════════════════════════════════════════════════════════

function extractCellsForTable(
  html: string,
  metaTableCode: number,
): CellRecord[] {
  const re = /"cells":\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const peek = html.slice(m.index + 9, m.index + 300);
    const metaMatch = peek.match(/"metaTableCode":(\d+)/);
    if (!metaMatch || parseInt(metaMatch[1]!) !== metaTableCode) continue;
    const arrStart = m.index + 9;
    const cells = parseCellsArray(html.slice(arrStart));
    if (cells.length > 0) return cells;
  }
  return [];
}

function parseCellsArray(rawArray: string): CellRecord[] {
  const cells: CellRecord[] = [];
  let idx = 0;
  while (true) {
    const p = rawArray.indexOf('{"metaTableId":', idx);
    if (p === -1) break;

    let depth = 0,
      inStr = false,
      esc = false,
      end = -1;
    for (let i = p; i < rawArray.length && i < p + 50000; i++) {
      const ch = rawArray[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        if (inStr) esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > p) {
      const cellStr = rawArray.slice(p, end);
      try {
        const obj = JSON.parse(cellStr);
        if (obj && typeof obj === "object" && obj.metaTableId !== undefined) {
          cells.push(obj);
        }
      } catch {
        /* skip */
      }
      idx = end;
    } else {
      idx = p + 1;
    }
  }
  return cells;
}

export function extractMonthlySalesAmount(html: string): number | null {
  const cells = extractCellsForTable(html, 1197);
  if (cells.length === 0) return null;

  const domesticLabel = cells.find((c) => c.value === "جمع فروش داخلی");
  const exportLabel = cells.find((c) => c.value === "جمع فروش صادراتی");

  const findMonthlyAmount = (rowCode: number | undefined) => {
    if (rowCode === undefined) return null;
    const cell = cells.find(
      (c) =>
        c.rowCode === rowCode &&
        c.columnCode === 17 &&
        /^\d+$/.test(c.value ?? ""),
    );
    return cell ? parseInt(cell.value!, 10) : null;
  };

  let total = 0;
  let found = false;
  const d = findMonthlyAmount(domesticLabel?.rowCode);
  const e = findMonthlyAmount(exportLabel?.rowCode);
  if (d !== null) {
    total += d;
    found = true;
  }
  if (e !== null) {
    total += e;
    found = true;
  }
  if (found) return total;

  const productSales = cells
    .filter(
      (c) =>
        c.columnCode === 17 &&
        c.rowCode === 4 &&
        /^\d+$/.test(c.value ?? "") &&
        parseInt(c.value, 10) > 0,
    )
    .map((c) => parseInt(c.value, 10));
  if (productSales.length > 0) return productSales.reduce((a, b) => a + b, 0);

  const allCol17 = cells
    .filter((c) => c.columnCode === 17 && /^\d+$/.test(c.value ?? ""))
    .map((c) => parseInt(c.value, 10));
  if (allCol17.length > 0) return Math.max(...allCol17);

  return null;
}

export function extractMonthlyReport(
  html: string,
  title: string,
): {
  periodEnd: string | null;
  goods: MonthlySalesRow[];
  totals: MonthlySalesRow[];
  monthlySalesTotal: number | null;
  ytdSalesTotal: number | null;
  priorYtdSalesTotal: number | null;
  domesticMonthly: number | null;
  exportMonthly: number | null;
  serviceMonthly: number | null;
} | null {
  const cells = extractCellsForTable(html, 1197);
  if (cells.length === 0) return null;

  const val = (rc: number, col: number): number | null => {
    const cell = cells.find((c) => c.rowCode === rc && c.columnCode === col);
    if (!cell || !cell.value) return null;
    const s = cell.value.trim();
    if (!/^-?\d+$/.test(s)) return null;
    return parseInt(s, 10);
  };
  const label = (rc: number): string =>
    cells.find((c) => c.rowCode === rc && c.columnCode === 1)?.value?.trim() ??
    cells.find((c) => c.rowCode === rc && c.columnCode === 26)?.value?.trim() ??
    "";

  const toRow = (rc: number): MonthlySalesRow | null => {
    const rows = cells.filter((c) => c.rowCode === rc);
    if (rows.length === 0) return null;
    return {
      rowCode: rc,
      label: label(rc),
      qtyPeriod: val(rc, 14),
      valuePeriod: val(rc, 17),
      qtyYtd: val(rc, 18),
      valueYtd: val(rc, 21),
      qtyPriorYtd: val(rc, 22),
      valuePriorYtd: val(rc, 25),
      rowTypeName: rows[0]?.rowTypeName ?? "",
    };
  };

  const products: MonthlySalesRow[] = [];
  const seqSet = new Set<number>();
  for (const c of cells) {
    if (c.rowCode === 4 && c.rowSequence !== undefined)
      seqSet.add(c.rowSequence);
  }
  for (const seq of seqSet) {
    const rowCells = cells.filter(
      (c) => c.rowCode === 4 && c.rowSequence === seq,
    );
    if (rowCells.length === 0) continue;
    const g = (col: number): number | null => {
      const cell = rowCells.find((c) => c.columnCode === col);
      if (!cell || !cell.value) return null;
      const s = cell.value.trim();
      return /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
    };
    const lab =
      rowCells.find((c) => c.columnCode === 26)?.value?.trim() ??
      rowCells.find((c) => c.columnCode === 1)?.value?.trim() ??
      "";
    products.push({
      rowCode: 4,
      label: lab,
      qtyPeriod: g(14),
      valuePeriod: g(17),
      qtyYtd: g(18),
      valueYtd: g(21),
      qtyPriorYtd: g(22),
      valuePriorYtd: g(25),
      rowTypeName: rowCells[0]?.rowTypeName ?? "",
    });
  }

  const totals: MonthlySalesRow[] = [];
  for (const rc of [5, 8, 11, 14, 15, 16]) {
    const r = toRow(rc);
    if (r) totals.push(r);
  }

  const monthlySalesTotal = extractMonthlySalesAmount(html);
  const totalRow = totals.find((t) => t.rowCode === 16);
  const domRow = totals.find((t) => t.rowCode === 5);
  const expRow = totals.find((t) => t.rowCode === 8);

  const jalali = extractJalaliPeriodEnd(title);
  const periodEnd = jalali
    ? `${jalali.jy}/${String(jalali.jm).padStart(2, "0")}/${String(jalali.jd).padStart(2, "0")}`
    : null;

  const serviceRow = totals.find((t) => t.rowCode === 11);
  return {
    periodEnd,
    goods: products,
    totals,
    monthlySalesTotal,
    ytdSalesTotal: totalRow?.valueYtd ?? null,
    priorYtdSalesTotal: totalRow?.valuePriorYtd ?? null,
    domesticMonthly: domRow?.valuePeriod ?? null,
    exportMonthly: expRow?.valuePeriod ?? null,
    serviceMonthly: serviceRow?.valuePeriod ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// Quarterly income statement parsing (rayanDynamicStatement HTML)
// ═══════════════════════════════════════════════════════════════
export function extractIncomeStatement(
  html: string,
): QuarterlyFinancials | null {
  const tableMatch = html.match(
    /<table[^>]*class="[^"]*rayanDynamicStatement[^"]*"[^>]*>([\s\S]*?)<\/table>/,
  );
  if (!tableMatch) return null;
  const tableHtml = tableMatch[0];

  // ── Parse header: period-end dates + cumulative duration (months) ──
  const periodEnds: string[] = [];
  const durationMonths: number[] = [];
  const headerRe =
    /<th[^>]*>\s*<span[^>]*>([^<]*(?:دوره|تجديد|تجدید)[^<]*)<\/span>/g;
  let hm: RegExpExecArray | null;
  while ((hm = headerRe.exec(tableHtml)) !== null) {
    const txt = toAsciiDigits(hm[1]!.trim());
    const dm = txt.match(/(\d{4})\/(\d{2})\/(\d{2})/);
    if (!dm) continue;
    periodEnds.push(`${dm[1]}/${dm[2]}/${dm[3]}`);

    const monMatch = txt.match(/(\d{1,2})\s*ماهه/);
    durationMonths.push(monMatch ? parseInt(monMatch[1]!, 10) : 0);
  }

  const parseNumberCell = (raw: string): number | null => {
    let s = toAsciiDigits(raw).trim();
    if (!s || s === "-" || s === "—" || s === "--") return null;
    const negative = /^\(/.test(s);
    s = s.replace(/[()\s,،٫]/g, "");
    if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
    const n = parseFloat(s);
    return negative ? -n : n;
  };

  const extractRowValues = (
    rowHtml: string,
    expectedCount: number,
  ): Array<number | null> => {
    const allValues: Array<number | null> = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowHtml)) !== null) {
      const text = cm[1]!.replace(/<[^>]+>/g, "").trim();
      allValues.push(parseNumberCell(text));
    }
    return allValues.slice(1, 1 + expectedCount);
  };

  const periodCount = periodEnds.length || 3;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rm: RegExpExecArray | null;
  let revenues: Array<number | null> = [];
  let netProfits: Array<number | null> = [];
  let eps: Array<number | null> = [];
  let capitals: Array<number | null> = [];

  while ((rm = rowRe.exec(tableHtml)) !== null) {
    const rowHtml = rm[1]!;
    const labelMatch = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/);
    if (!labelMatch) continue;

    const label = labelMatch[1]!
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const values = extractRowValues(rowHtml, periodCount);
    if (values.every((v) => v === null)) continue;

    // ---- Skip cost / expense rows first ----
    if (
      /بهای تمام شده|بهاى تمام شده|بهاي تمام شده|هزینه|هزينه/.test(label)
    ) {
      continue;
    }

    // ---- Revenue (Operating Income) ----
    if (
      revenues.length === 0 &&
      /درآمدهای? عملیاتی|درآمدهاي عملياتي|درآمدهاي عملیاتی/.test(label)
    ) {
      revenues = values;
      continue;
    }

    // ---- Net Profit (سود خالص) - robust matching ----
    if (
      netProfits.length === 0 &&
      /سود\s*\(?\s*زیان\s*\)?\s*خالص|سود\s*\(?\s*زيان\s*\)?\s*خالص|سود\s*خالص/.test(
        label,
      ) &&
      !/هر سهم|پایه هر سهم|عملیات در حال تداوم|عملیات متوقف|عمليات در حال تداوم|عمليات متوقف/.test(
        label,
      )
    ) {
      netProfits = values;
      continue;
    }

    // ---- EPS ----
    if (
      eps.length === 0 &&
      /سود\s*\(?\s*زیان\s*\)?\s*خالص\s*هر\s*سهم|سود\s*خالص\s*هر\s*سهم/.test(
        label,
      )
    ) {
      eps = values;
      continue;
    }

    // ---- Capital ----
    if (
      capitals.length === 0 &&
      (label === "سرمایه" || label === "سرمايه")
    ) {
      capitals = values;
      continue;
    }
  }

  if (revenues.length === 0 && netProfits.length === 0) return null;

  // ── Compute margins ──
  const len = Math.max(revenues.length, netProfits.length, periodEnds.length);
  const margins: Array<number | null> = [];
  for (let i = 0; i < len; i++) {
    const r = revenues[i];
    const p = netProfits[i];
    if (r && r > 0 && p !== null && p !== undefined) {
      margins.push(p / r);
    } else {
      margins.push(null);
    }
  }

  // ── Pick latest period: prefer positive interim margin ──
  let latestMargin: number | null = null;
  let latestPeriod: string | null = null;

  // Step 1: first INTERIM period with POSITIVE margin
  for (let i = 0; i < margins.length; i++) {
    const period = periodEnds[i];
    const m = margins[i];
    if (!period || m === null || m === undefined) continue;
    if (period.endsWith("/12/29") || period.endsWith("/12/30")) continue;
    if (m > 0) {
      latestMargin = m;
      latestPeriod = period;
      break;
    }
  }

  // Step 2: any positive margin
  if (latestMargin === null) {
    for (let i = 0; i < margins.length; i++) {
      const period = periodEnds[i];
      const m = margins[i];
      if (!period || m === null || m === undefined) continue;
      if (m > 0) {
        latestMargin = m;
        latestPeriod = period;
        break;
      }
    }
  }

  // Step 3: first interim (even negative)
  if (latestMargin === null) {
    for (let i = 0; i < margins.length; i++) {
      const period = periodEnds[i];
      const m = margins[i];
      if (!period || m === null || m === undefined) continue;
      if (period.endsWith("/12/29") || period.endsWith("/12/30")) continue;
      latestMargin = m;
      latestPeriod = period;
      break;
    }
  }

  // Step 4: first available
  if (latestMargin === null) {
    const m = margins[0];
    if (m !== null && m !== undefined) {
      latestMargin = m;
      latestPeriod = periodEnds[0] ?? null;
    }
  }

  const latestCapital = capitals.find((c) => c !== null && c > 0) ?? null;
  const sharesOutstanding = latestCapital ? latestCapital * 1000 : null;

  return {
    periodEnds,
    durationMonths,
    revenues,
    netProfits,
    eps,
    capitals,
    margins,
    latestMargin,
    latestPeriod,
    sharesOutstanding,
  };
}

// ═══════════════════════════════════════════════════════════════
// Fetch helpers
// ═══════════════════════════════════════════════════════════════

/** Simple fetch for monthly reports (datasource HTML). */
export async function fetchReportHtml(relativeUrl: string): Promise<string> {
  const url = relativeUrl.startsWith("/")
    ? `${CODAL_BASE}${relativeUrl}`
    : `${CODAL_BASE}/${relativeUrl}`;

  return reportLimiter.run(() =>
    codalGetText(url, {
      ...H,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }),
  );
}

/**
 * Fetch income-statement HTML with a real browser.
 * Codal's income statement is rendered via ASP.NET postback after selecting
 * "صورت سود و زیان" from `#ctl00_ddlTable`.
 */
async function fetchIncomeStatementHtml(relativeUrl: string): Promise<string> {
  const context = await getCodalContext();
  const page = await context.newPage();

  const url = relativeUrl.startsWith("/")
    ? `${CODAL_BASE}${relativeUrl}`
    : `${CODAL_BASE}/${relativeUrl}`;

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const initialHtml = await page.content();

    if (looksLikeCaptcha(initialHtml)) {
      await pauseForManualCaptcha(url);

      // Reload after you solve the challenge.
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }

    // Wait for network to settle (Angular/ASP.NET)
    try {
      await page.waitForLoadState("networkidle", { timeout: 20000 });
    } catch {
      /* ignore — some pages keep polling */
    }

    // ── Check for dropdown ──
    const hasDropdown = await page
      .locator("#ctl00_ddlTable")
      .count()
      .then((c) => c > 0);

    if (!hasDropdown) {
      // Some reports have no dropdown — return whatever we got
      await page.waitForTimeout(2000);
      return await page.content();
    }

    // ── Select "صورت سود و زیان" (value = "1") ──
    await page.selectOption("#ctl00_ddlTable", "1");
    await page.waitForTimeout(2500);

    try {
      await page.waitForSelector('table[class*="rayanDynamicStatement"]', {
        timeout: 15000,
      });
    } catch {
      /* fall through — some reports have no income statement */
    }

    await page.waitForTimeout(1000);
    return await page.content();
  } finally {
    await page.close().catch(() => undefined);
    // Do not close the shared context; its cookies are needed for retries.
  }
}

// ─── codal.ts ────────────────────────────────────────────────

export interface MonthlySalesFull {
  period: string; // "1402/06/31"
  periodEnd: { jy: number; jm: number; jd: number };
  domestic: number;
  export: number;
  service: number;
  ytdTotal: number | null;
  ytdPriorYearTotal: number | null;
  total: number;
  url: string;
  revision: boolean;
  reportDate: string; // ISO Gregorian
  detail: ReturnType<typeof extractMonthlyReport> | null;
}

/**
 * Row codes in Codal's monthly-activity table (metaTableCode = 1197):
 *   4  → goods (per-product rows, rowSequence split)
 *   5  → جمع فروش داخلی        (domestic total)
 *   8  → جمع فروش صادراتی      (export total)
 *   11 → جمع فروش خدمات        (services total)   ← add this
 *   14 → جمع درآمد عملیاتی     (operating revenue total, sometimes blank)
 *   15 → سایر درآمدها
 *   16 → جمع درآمدها           (grand total)
 *
 * Column codes:
 *   14 → quantity this month
 *   17 → value this month       (Rial, "million Rial" in Codal UI)
 *   18 → quantity YTD
 *   21 → value YTD
 *   22 → quantity prior YTD
 *   25 → value prior YTD
 */
const ROW = {
  DOMESTIC: 5,
  EXPORT: 8,
  SERVICE: 11,
  OPERATING: 14,
  OTHER: 15,
  TOTAL: 16,
} as const;

const COL = {
  QTY_MONTH: 14,
  VAL_MONTH: 17,
  QTY_YTD: 18,
  VAL_YTD: 21,
  QTY_PRIOR_YTD: 22,
  VAL_PRIOR_YTD: 25,
} as const;

export function extractMonthlySalesFull(
  html: string,
  title: string,
  reportUrl: string,
  _publishDateTime: string,
): MonthlySalesFull | null {
  const cells = extractCellsForTable(html, 1197);
  if (cells.length === 0) return null;

  const val = (rc: number, col: number): number | null => {
    const cell = cells.find((c) => c.rowCode === rc && c.columnCode === col);
    if (!cell || !cell.value) return null;
    const s = cell.value.trim();
    if (!/^-?\d+$/.test(s)) return null;
    return parseInt(s, 10);
  };

  const domestic = val(ROW.DOMESTIC, COL.VAL_MONTH) ?? 0;
  const exportAmt = val(ROW.EXPORT, COL.VAL_MONTH) ?? 0;
  const service = val(ROW.SERVICE, COL.VAL_MONTH) ?? 0;

  // Row 11 ("بهای تمام شده انتسابی") is an attributable-COST row in these
  // reports — its value is NEGATIVE (see `details.totals`: 2,413,479 domestic
  // vs −2,254,101 attributable cost). Reports with no grand-total row fall
  // back to the sum, and summing the cost row produced GROSS PROFIT, not
  // sales: 2,413,479 + 0 − 2,254,101 = 159,378 got stored as the month's
  // sales. Exclude SERVICE when it is a cost (negative); keep it only when
  // it is genuine service revenue.
  const grandTotal = val(ROW.TOTAL, COL.VAL_MONTH);
  const total = grandTotal ?? domestic + exportAmt + Math.max(0, service);

  const ytdTotal = val(ROW.TOTAL, COL.VAL_YTD);
  const ytdPriorYearTotal = val(ROW.TOTAL, COL.VAL_PRIOR_YTD);

  const periodEnd = extractJalaliPeriodEnd(title);
  if (!periodEnd) return null;

  const revision = title.includes("اصلاحیه") || /اصلاحیه/.test(title);

  const reportDate = toIsoDate(
    jalaliToGregorian(periodEnd.jy, periodEnd.jm, periodEnd.jd),
  );

  return {
    period: `${periodEnd.jy}/${String(periodEnd.jm).padStart(2, "0")}/${String(periodEnd.jd).padStart(2, "0")}`,
    periodEnd,
    domestic,
    export: exportAmt,
    service,
    ytdTotal,
    ytdPriorYearTotal,
    total,
    url: reportUrl,
    revision,
    reportDate,
    detail: extractMonthlyReport(html, title),
  };
}

// ═══════════════════════════════════════════════════════════════
// Public fetchers
// ═══════════════════════════════════════════════════════════════

export interface MonthlyReportResult {
  periodEnd: { jy: number; jm: number; jd: number };
  amount: number;
  reportUrl: string;
  detail: ReturnType<typeof extractMonthlyReport> | null;
  /** NEW: full row for the USD conversion pipeline */
  full?: MonthlySalesFull;
}

export async function fetchMonthlySales(
  symbol: string,
  count = 3,
): Promise<MonthlyReportResult[]> {
  const letters = await searchLetters(symbol);
  const monthly = filterMonthlySalesLetters(letters); // keep اصلاحیه out of
  // ...but if you want to ingest revisions too, drop the !title.includes("اصلاحیه")
  // filter and let the DB upsert decide.

  const results: MonthlyReportResult[] = [];

  for (const letter of monthly.slice(0, count)) {
    const period = extractJalaliPeriodEnd(letter.title);
    if (!period) continue;

    try {
      const html = await fetchReportHtml(letter.url);
      const detail = extractMonthlyReport(html, letter.title);
      const full = extractMonthlySalesFull(
        html,
        letter.title,
        `${CODAL_BASE}${letter.url}`,
        letter.publishDateTime,
      );
      if (!full) continue;

      results.push({
        periodEnd: period,
        amount: full.total,
        reportUrl: full.url,
        detail,
        full,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `  [${symbol}] Codal report parse failed: ${msg.slice(0, 100)}`,
      );
    }
  }
  return results;
}

/**
 * Fetch the latest quarterly income statement for a symbol.
 * This is much more efficient than fetching all quarters.
 */
export async function fetchLatestQuarterlyFinancials(
  symbol: string,
  maxYear?: number,
): Promise<QuarterlyResult | null> {
  // Search for quarterly reports - we only need the first page
  // because Codal returns letters newest-first.
  const letters = await searchLetters(symbol, {
    LetterType: "6",
    PageNumber: "1",
  });

  if (!letters || letters.length === 0) return null;

  // Filter out revision/final reports
  const filtered = letters.filter(
    (l) =>
      (l.title.includes("صورت") || l.title.includes("مالی")) &&
      !l.title.includes("اصلاحیه") &&
      !l.title.includes("تفسیری"),
  );

  // Sort by publishDateTime descending (newest first) and reject any that are
  // older than maxYear (if provided).
  for (const letter of filtered.sort(
    (a, b) =>
      new Date(b.publishDateTime).getTime() -
      new Date(a.publishDateTime).getTime(),
  )) {
    const pubYear = new Date(letter.publishDateTime).getFullYear();
    if (maxYear != null && pubYear > maxYear) continue;

    try {
      const html = await fetchIncomeStatementHtml(letter.url);
      const fin = extractIncomeStatement(html);
      if (fin && fin.latestMargin !== null) {
        return {
          latestPeriod: fin.latestPeriod,
          latestMargin: fin.latestMargin,
          financials: fin,
          reportUrl: `${CODAL_BASE}${letter.url}`,
        };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Log the exact letter that failed, so you can see the URL.
      console.warn(
        `  [${symbol}] quarterly parse failed (latest only): ${msg.slice(0, 100)} – URL ${CODAL_BASE}${letter.url}`,
      );
      if (/^Browser unavailable:/.test(msg)) {
        console.warn(
          `  [${symbol}] skipping remaining letters – browser cannot launch`,
        );
        return null;
      }
    }
  }

  return null;
}

// Keep the old fetchQuarterlyFinancials for backward compatibility
export async function fetchQuarterlyFinancials(
  symbol: string,
  maxYear?: number,
  minYear?: number,
): Promise<QuarterlyResult | null> {
  // Paginate through Codal search to find ALL quarterly income statements
  // (not just page 1). Codal caps at 20 letters per page.
  const allLetters: CodalLetter[] = [];
  for (let page = 1; page <= 20; page++) {
    const letters = await searchLetters(symbol, {
      LetterType: "6",
      PageNumber: String(page),
    });
    if (letters.length === 0) break;
    allLetters.push(...letters);
    if (letters.length < 20) break;
  }

  const filtered = allLetters.filter(
    (l) =>
      (l.title.includes("صورت") || l.title.includes("مالی")) &&
      !l.title.includes("اصلاحیه") &&
      !l.title.includes("تفسیری"),
  );

  // Filter by year range (using publishDateTime)
  for (const letter of filtered) {
    if (maxYear != null || minYear != null) {
      try {
        const pub = new Date(letter.publishDateTime);
        const yr = pub.getFullYear();
        if (maxYear != null && yr > maxYear) continue;
        if (minYear != null && yr < minYear) continue;
      } catch {
        // malformed date → keep it, it has a year anyway
      }
    }

    try {
      const html = await fetchIncomeStatementHtml(letter.url);
      const fin = extractIncomeStatement(html);
      if (fin && fin.latestMargin !== null) {
        return {
          latestPeriod: fin.latestPeriod,
          latestMargin: fin.latestMargin,
          financials: fin,
          reportUrl: `${CODAL_BASE}${letter.url}`,
        };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `  [${symbol}] quarterly parse failed: ${msg.slice(0, 100)}`,
      );
      if (/^Browser unavailable:/.test(msg)) {
        console.warn(
          `  [${symbol}] skipping remaining ${filtered.length - filtered.indexOf(letter) - 1} letters — browser cannot launch`,
        );
        return null;
      }
    }
  }
  return null;
}

export { CODAL_SEARCH as API_BASE, CODAL_BASE };
