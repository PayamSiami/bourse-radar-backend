/**
 * Bourse Radar — LLM Narrative Generation Service
 * Tehran Stock Exchange quantitative ranking engine
 *
 * Enforces: NO buy/sell signals. Only explains WHY a stock ranks as it does,
 * with explicit uncertainty disclosure. Uses Zod-structured output.
 *
 * TRANSPORT NOTE:
 *   This module talks to any OpenAI-compatible chat-completions endpoint.
 *   Configure via env: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL.
 *
 *   Do NOT point this at OpenCode's free tier — it is gated to the official
 *   OpenCode client and returns 403 regardless of transport. Use a paid
 *   provider (OpenAI, OpenRouter, DeepSeek, etc.).
 *
 * TIMEOUT NOTE:
 *   The OpenAI SDK's `timeout` option only covers time-to-first-byte
 *   (response headers). Once headers arrive, the SDK clears its timer and
 *   the body read has NO timeout. To protect against provider stalls we wrap
 *   every request in a hard-deadline `Promise.race` AND pass an
 *   AbortController so the underlying fetch is actually cancelled.
 */

import OpenAI from "openai";
import { z } from "zod";
import { config } from "#config";
import { logger } from "#utils/logger";

// ──────────────── Types ─────────────────────────────────

export type StockInput = Record<string, unknown>;
export type SectorAgg = Record<string, unknown>;
export type SectorAggMap = Map<string, SectorAgg>;

export type NarrativeFallback = {
  symbol: string;
  fallback: true;
  error: string;
  rawData: StockInput;
};

export type NarrativeResult = LlmNarrative | NarrativeFallback;

// ──────────────── Zod Schemas (structured output) ────────

export const LlmNarrativeSchema = z.object({
  headline: z.string().max(140).default("تحلیل عددی"),
  analysis: z.string().max(2000).default("داده کافی برای تحلیل موجود نیست."),
  quantitativeReasoning: z.string().max(500).default(""),
  uncertaintyDisclosure: z.string().max(500).default(""),
  riskFactors: z.array(z.string().max(200)).max(5).default([]),
  positiveFactors: z.array(z.string().max(200)).max(5).default([]),
  disclaimer: z
    .string()
    .max(300)
    .default("این یک برآورد عددی است، نه مشاوره سرمایه‌گذاری."),
  usage: z
    .object({
      promptTokens: z.number().default(0),
      completionTokens: z.number().default(0),
      totalTokens: z.number().default(0),
    })
    .default({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),

  trendDirection: z.enum(["up", "down", "neutral"]).default("neutral"),
  trendArrow: z.string().default("→"),
  confidenceScore: z.number().min(0).max(100).default(50),
  trendHorizon: z.enum(["1d", "1w", "1m"]).default("1w"),
  nearTermOutlook: z
    .string()
    .max(500)
    .default("چشم‌انداز کوتاه‌مدت نامشخص است."),
  predictionBasis: z
    .string()
    .max(300)
    .default("بر اساس الگوهای تاریخی و تحلیل کمی"),
  volatilityRisk: z.enum(["low", "medium", "high"]).default("medium"),
});

export type LlmNarrative = z.infer<typeof LlmNarrativeSchema>;

// ──────────────── JSON Extraction ────────────────────────

function extractJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* continue */
  }

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* continue */
    }
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {
      /* continue */
    }
  }

  throw new Error(`No JSON found in LLM response: ${raw.slice(0, 200)}`);
}

// ──────────────── Prompts ────────────────────────────────

const SYSTEM_PROMPT = `
شما یک تحلیل‌گر مالی عددی برای بازار سهام ایران (بورس تهران) هستید.
وظیفه شما تبیین این است که چرا یک سهم در رتبه خاصی قرار دارد — نه اینکه بگویید بخرید یا بفروشید.

قوانین سخت‌گیرانه:
1. فقط از داده‌های عددی ارائه‌شده در JSON استفاده کنید. هیچ حدسی نزنید.
2. اگر Forward P/E یا EPS غیرقابل محاسبه است، صراحتاً بگویید "قابل محاسبه نیست."
3. اگر شاخص‌های قیمتی روشن هستند، روند کوتاه‌مدت را با دقت بالا توصیف کنید.
4. همیشه منبع داده و سطح اطمینان را اعلام کنید.
5. در انتهای هر تحلیل، بیانیه عدم‌اعتماد را گنجانید: "این یک برآورد عددی است، نه مشاوره سرمایه‌گذاری."
6. اگر حاشیه سود از میانگین صنعتی بود (نه از صورت مالی شرکت)، این را صراحتاً بگویید.
7. اگر شرکت بانکی، بیمه‌ای یا سرمایه‌گذاری است، نوع مالی خاص آن را اعلام کنید.
8. از اصطلاحات "خرید"، "فروش"، "هدف قیمت"، "پیشنهاد خرید" استفاده نکنید.

⚠️ خروجی شما باید **فقط** یک آبجکت JSON معتبر باشد، بدون هیچ متن اضافه، بدون markdown، بدون توضیح.
ساختار دقیق JSON:
{
  "headline": "عنوان کوتاه حداکثر ۱۴۰ کاراکتر",
  "analysis": "تحلیل ۲-۳ پاراگرافی حداکثر ۲۰۰۰ کاراکتر",
  "quantitativeReasoning": "استدلال عددی حداکثر ۵۰۰ کاراکتر",
  "uncertaintyDisclosure": "بیان عدم قطعیت حداکثر ۵۰۰ کاراکتر",
  "riskFactors": ["ریسک ۱", "ریسک ۲"],
  "positiveFactors": ["عامل مثبت ۱", "عامل مثبت ۲"],
  "disclaimer": "بیانیه عدم‌اعتماد حداکثر ۳۰۰ کاراکتر",
  "trendDirection": "up | down | neutral",
  "trendArrow": "↑ | ↓ | →",
  "confidenceScore": 0-100,
  "trendHorizon": "1d | 1w | 1m",
  "nearTermOutlook": "چشم‌انداز نزدیک‌مدت حداکثر ۵۰۰ کاراکتر",
  "predictionBasis": "علت پیش‌بینی حداکثر ۳۰۰ کاراکتر",
  "volatilityRisk": "low | medium | high"
}
`.trim();

const USER_PROMPT_TEMPLATE = `
در ادامه داده‌های عددی یک سهم از بورس تهران را می‌بینید. یک تحلیل کوتاه (۲ تا ۳ پاراگراف)
به زبان فارسی بنویس که توضیح دهد چرا این سهم در رتبه {{RANK}} از {{TOTAL}} قرار دارد.

مگر بر اساس داده‌های فنی و بنیادی:
1. روند کوتاه‌مدت (همین هفته) را پیش‌بینی کن (صعودی/نزولی/خنثی)
2. از کدام جهت‌نما (↑↓→) استفاده می‌کنی
3. امتیاز اطمینان (۰-۱۰۰) بده
4. چشم‌انداز نزدیک‌مدت را در قالب "چه می‌تواند اتفاق بیفتد" توصیف کن

دقیقاً بر اساس داده‌ها حرف بزن — هیچ حدسی نداشته باشید. اگر داده‌ای کافی نیست، بگویید.

فقط JSON برگردان. بدون markdown، بدون متن اضافه.

ورودی JSON:
{{JSON_INPUT}}
`.trim();

// ──────────────── Config defaults ───────────────────────

const DEFAULT_CONCURRENCY = Number(process.env.LLM_CONCURRENCY ?? 3);
const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 90_000);

// Circuit-breaker tuning
const BREAKER_FAILURE_THRESHOLD = Number(
  process.env.LLM_BREAKER_THRESHOLD ?? 3,
);
const BREAKER_COOLDOWN_MS = Number(
  process.env.LLM_BREAKER_COOLDOWN_MS ?? 5 * 60 * 1000,
);

// ──────────────── Circuit Breaker (module-level) ─────────

class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  remainingMs(): number {
    return Math.max(0, this.openUntil - Date.now());
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= BREAKER_FAILURE_THRESHOLD) {
      this.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      logger.warn(
        `LLM circuit breaker OPEN for ${Math.round(
          BREAKER_COOLDOWN_MS / 1000,
        )}s after ${this.failures} consecutive failures`,
      );
      this.failures = 0;
    }
  }
}

const breaker = new CircuitBreaker();

// ──────────────── Hard-deadline helper ───────────────────

/**
 * Races `fn(signal)` against a hard deadline. On timeout, aborts the
 * underlying request via `AbortController` and rejects. This is needed
 * because the OpenAI SDK's `timeout` only covers TTFB; after headers
 * arrive, the body read is untimed and can hang indefinitely.
 */
async function withHardDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();

  // Chain external abort → our controller
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`LLM hard deadline (${timeoutMs}ms) exceeded`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ──────────────── LLM Narrator Class ─────────────────────

export class LlmNarrator {
  private client: OpenAI;
  public modelName: string;
  public concurrency: number;
  public timeoutMs: number;

  constructor(opts?: { concurrency?: number; timeoutMs?: number }) {
    // Env wins over config so you can swap providers without touching code.
    const apiKey = process.env.LLM_API_KEY ?? config.llm.apiKey;
    const baseURL = process.env.LLM_BASE_URL ?? config.llm.baseURL;
    const model = process.env.LLM_MODEL ?? config.llm.model;

    if (!apiKey) {
      throw new Error(
        "LlmNarrator: LLM_API_KEY is not set. Configure an OpenAI-compatible provider.",
      );
    }

    this.client = new OpenAI({
      apiKey,
      baseURL,
      maxRetries: 0, // breaker owns retry policy
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    this.modelName = model;
    this.concurrency = Math.max(1, opts?.concurrency ?? DEFAULT_CONCURRENCY);
    this.timeoutMs = Math.max(1000, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async generate(
    stockInput: StockInput,
    signal?: AbortSignal,
  ): Promise<LlmNarrative> {
    if (breaker.isOpen()) {
      throw new Error(
        `LLM circuit breaker open (${breaker.remainingMs()}ms remaining)`,
      );
    }

    const jsonInput = JSON.stringify(stockInput, null, 2);
    const userPrompt = USER_PROMPT_TEMPLATE.replace(
      "{{RANK}}",
      String(stockInput["rankingPosition"] ?? "?"),
    )
      .replace("{{TOTAL}}", String(stockInput["totalStocksRanked"] ?? "?"))
      .replace("{{JSON_INPUT}}", jsonInput);

    try {
      const response = await withHardDeadline(
        (requestSignal) =>
          this.client.chat.completions.create(
            {
              model: this.modelName,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
              ],
              max_tokens: config.llm.maxTokens,
              temperature: config.llm.temperature,
              response_format: { type: "json_object" },
            },
            { signal: requestSignal, timeout: this.timeoutMs },
          ),
        this.timeoutMs,
        signal,
      );

      const raw = response.choices[0]?.message?.content;
      if (!raw) throw new Error("Empty LLM response");

      const parsed = extractJson(raw) as Record<string, unknown>;

      const narrative = LlmNarrativeSchema.parse({
        ...parsed,
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
      });

      breaker.recordSuccess();
      return narrative;
    } catch (err) {
      // User-aborted requests must not count against the breaker.
      if (!signal?.aborted) breaker.recordFailure();

      logger.error(
        err,
        `LLM narrative generation failed for ${stockInput["symbol"] ?? "unknown"}`,
      );
      throw err;
    }
  }

  async generateBatch(
    stocks: StockInput[],
    sectorAggs?: SectorAggMap,
    signal?: AbortSignal,
  ): Promise<NarrativeResult[]> {
    if (stocks.length === 0) return [];

    const CONCURRENCY = Math.min(this.concurrency, stocks.length);
    const results: Array<PromiseSettledResult<LlmNarrative>> = new Array(
      stocks.length,
    );
    let cursor = 0;
    const self = this;

    async function worker() {
      while (true) {
        if (signal?.aborted) return;
        // If breaker opened mid-batch, stop pulling new items.
        if (breaker.isOpen()) return;

        const i = cursor++;
        if (i >= stocks.length) return;
        const stock = stocks[i];
        if (!stock) continue;

        const input = buildLlmInput(stock, sectorAggs);

        try {
          const value = await self.generate(input, signal);
          results[i] = { status: "fulfilled", value };
        } catch (reason) {
          results[i] = { status: "rejected", reason };
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // 1:1 mapping — anything not fulfilled (rejected, skipped by breaker,
    // or aborted) becomes a fallback so callers can rely on
    // `results.length === stocks.length`.
    return results.map((r, i) => {
      if (r?.status === "fulfilled") return r.value;

      const stock = stocks[i];
      const symbol = (stock?.["symbol"] as string) ?? "unknown";
      const error =
        r?.status === "rejected"
          ? r.reason instanceof Error
            ? r.reason.message
            : String(r.reason)
          : signal?.aborted
            ? "aborted"
            : breaker.isOpen()
              ? "circuit breaker open"
              : "unknown error";

      logger.warn(`LLM failed for ${symbol}, returning fallback: ${error}`);

      return {
        symbol,
        fallback: true as const,
        error: `LLM generation failed: ${error}. Raw quantitative rankings provided instead.`,
        rawData: stock ?? {},
      };
    });
  }
}

// ──────────────── LLM Input Builder ──────────────────────

export function buildLlmInput(
  row: StockInput,
  sectorAggs?: SectorAggMap,
): StockInput {
  const calcDetails = (row["calcDetails"] as Record<string, unknown>) || {};
  const sector = row["sector"] as string;
  const sectorAgg = sectorAggs?.get(sector);

  return {
    symbol: row["symbol"],
    name: row["name"],
    sector,
    currentPrice: row["last_price"],
    trailingPe: null,
    forwardPe: row["forward_pe"],
    estimatedAnnualEps: row["estimated_annual_eps"],
    forwardPeConfidence: row["confidence"],
    confidenceScore: row["confidence_score"],
    netMargin: calcDetails["netMargin"],
    marketCap: null,
    dailyVolume: row["volume"],
    volumeValue: null,
    priceChange24h: 0,
    priceChangePercent24h: 0,
    rankingPosition: row["overallRank"],
    totalStocksRanked: row["total"] ?? 0,
    liquidityPercentile: 0,
    marketCapPercentile: 0,
    dataFreshness: {
      priceAgeSeconds: 0,
      salesAgeDays: 0,
      quarterlyAgeDays: 0,
    },
    isBank: false,
    isInsurance: false,
    isHoldingCompany: false,
    calculationDisclaimer: row["disclaimer"],
    sectorAvgForwardPe: sectorAgg ? sectorAgg["avgForwardPe"] : null,
  };
}
