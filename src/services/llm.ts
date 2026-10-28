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
 * TIMEOUT NOTE:
 *   The OpenAI SDK's `timeout` option only covers time-to-first-byte.
 *   We wrap every request in a hard-deadline Promise.race + AbortController.
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

// ──────────────── Zod Schemas ────────────────────────────

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

  // New fields - use optional to avoid failures if LLM doesn't return them
  trendDirection: z
    .enum(["up", "down", "neutral"])
    .optional()
    .default("neutral"),
  trendArrow: z.string().optional().default("→"),
  confidenceScore: z
    .number()
    .min(0)
    .max(100)
    .refine((v) => !isNaN(v), "Confidence must be a number")
    .default(50),
  trendHorizon: z.enum(["1d", "1w", "1m"]).optional().default("1w"),
  nearTermOutlook: z
    .string()
    .max(500)
    .optional()
    .default("چشم‌انداز کوتاه‌مدت نامشخص است."),
  predictionBasis: z
    .string()
    .max(300)
    .optional()
    .default("بر اساس داده‌های عددی"),
  volatilityRisk: z
    .enum(["low", "medium", "high"])
    .optional()
    .default("medium"),
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
تحلیل‌گر عددی بورس تهران هستی.
فقط از داده‌های داده‌شده استفاده کن.
هیچ توصیه خرید/فروش نده.
فقط JSON معتبر برگردان.

ساختار:
{
  "headline": "عنوان کوتاه",
  "analysis": "تحلیل ۲ پاراگراف",
  "quantitativeReasoning": "استدلال عددی",
  "uncertaintyDisclosure": "عدم قطعیت",
  "riskFactors": ["ریسک"],
  "positiveFactors": ["مثبت"],
  "disclaimer": "این برآورد عددی است نه مشاوره",
  "trendDirection": "up|down|neutral",
  "confidenceScore": 0-100,
  "nearTermOutlook": "چشم‌انداز کوتاه‌مدت"
}
`.trim();

const USER_PROMPT_TEMPLATE = `
سهم در رتبه {{RANK}} از {{TOTAL}}.
بر اساس داده‌های زیر تحلیل کن و فقط JSON برگردان:

{{JSON_INPUT}}
`.trim();

// ──────────────── Config defaults ───────────────────────

const DEFAULT_CONCURRENCY = Number(process.env.LLM_CONCURRENCY ?? 1);
const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000); // reduced to 30s

const BREAKER_FAILURE_THRESHOLD = Number(
  process.env.LLM_BREAKER_THRESHOLD ?? 5,
);
const BREAKER_COOLDOWN_MS = Number(
  process.env.LLM_BREAKER_COOLDOWN_MS ?? 5 * 60 * 1000,
);
const BREAKER_TIMEOUT_GRACE = Number(
  process.env.LLM_BREAKER_TIMEOUT_GRACE ?? 2,
);

// ──────────────── Circuit Breaker ────────────────────────

class CircuitBreaker {
  private failures = 0;
  private timeoutCount = 0;
  private openUntil = 0;

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  remainingMs(): number {
    return Math.max(0, this.openUntil - Date.now());
  }

  recordSuccess(): void {
    this.failures = 0;
    this.timeoutCount = 0;
    this.openUntil = 0;
  }

  recordFailure(isTimeout = false): void {
    if (isTimeout) {
      this.timeoutCount += 1;
      if (this.timeoutCount <= BREAKER_TIMEOUT_GRACE) {
        logger.warn(
          `LLM timeout (${this.timeoutCount}/${BREAKER_TIMEOUT_GRACE} grace) – not counting toward breaker`,
        );
        return;
      }
    }

    this.failures += 1;
    if (this.failures >= BREAKER_FAILURE_THRESHOLD) {
      this.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      logger.warn(
        `LLM circuit breaker OPEN for ${Math.round(
          BREAKER_COOLDOWN_MS / 1000,
        )}s after ${this.failures} consecutive failures`,
      );
      this.failures = 0;
      this.timeoutCount = 0;
    }
  }
}

const breaker = new CircuitBreaker();

// ──────────────── Hard-deadline helper ───────────────────

async function withHardDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ result: T; elapsedMs: number }> {
  const controller = new AbortController();
  const start = Date.now();

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
      (err as any).isTimeout = true;
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(controller.signal), deadline]);
    return { result, elapsedMs: Date.now() - start };
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
      maxRetries: 0,
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

    const start = Date.now();
    let isTimeout = false;

    try {
      const { result: response, elapsedMs } = await withHardDeadline(
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
              // response_format: { type: "json_object" },
            },
            { signal: requestSignal, timeout: this.timeoutMs },
          ),
        this.timeoutMs,
        signal,
      );

      const choice = response.choices?.[0];
      const message = choice?.message;
      const raw = message?.content;

      if (!raw || typeof raw !== "string" || raw.trim() === "") {
        const finishReason = choice?.finish_reason ?? "unknown";
        const refusal = (message as any)?.refusal;

        logger.error(
          {
            finish_reason: finishReason,
            refusal,
            usage: response.usage,
            model: this.modelName,
            symbol: stockInput["symbol"],
            elapsedMs,
          },
          "Empty or missing LLM content",
        );

        throw new Error(
          `Empty LLM response (finish_reason=${finishReason}${
            refusal ? `, refusal=${refusal}` : ""
          })`,
        );
      }

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

      if (elapsedMs > this.timeoutMs * 0.7) {
        logger.warn(
          {
            symbol: stockInput["symbol"],
            elapsedMs,
            model: this.modelName,
          },
          "LLM response was slow but succeeded",
        );
      }

      return narrative;
    } catch (err) {
      isTimeout =
        !!(err as any)?.isTimeout ||
        (err instanceof Error && err.message.includes("hard deadline"));

      if (!signal?.aborted) {
        breaker.recordFailure(isTimeout);
      }

      logger.error(
        {
          err,
          symbol: stockInput["symbol"] ?? "unknown",
          isTimeout,
          elapsedMs: Date.now() - start,
          model: this.modelName,
        },
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
    // Pre-fill so we never have holes
    const results: Array<PromiseSettledResult<LlmNarrative> | null> = new Array(
      stocks.length,
    ).fill(null);

    let cursor = 0;
    const self = this;

    async function worker() {
      while (true) {
        if (signal?.aborted) return;
        if (breaker.isOpen()) return;

        const i = cursor++;
        if (i >= stocks.length) return;

        const stock = stocks[i];
        if (!stock) {
          results[i] = {
            status: "rejected",
            reason: new Error("empty stock slot"),
          };
          continue;
        }

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

    // Always return a dense array
    return results.map((r, i) => {
      const stock = stocks[i];
      const symbol = (stock?.["symbol"] as string) ?? "unknown";

      if (r?.status === "fulfilled") return r.value;

      const error =
        r?.status === "rejected"
          ? r.reason instanceof Error
            ? r.reason.message
            : String(r.reason)
          : signal?.aborted
            ? "aborted"
            : breaker.isOpen()
              ? "circuit breaker open"
              : "worker did not run (unknown)";

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
  // const calcDetails = (row["calcDetails"] as Record<string, unknown>) || {};
  const sector = row["sector"] as string;
  const sectorAgg = sectorAggs?.get(sector);

  return {
    symbol: row["symbol"],
    name: row["name"],
    sector,
    currentPrice: row["last_price"],
    forwardPe: row["forward_pe"],
    estimatedAnnualEps: row["estimated_annual_eps"],
    confidence: row["confidence"],
    confidenceScore: row["confidence_score"],
    volume: row["volume"],
    rankingPosition: row["overallRank"],
    totalStocksRanked: row["total"] ?? 0,
    disclaimer: row["disclaimer"],
    sectorAvgForwardPe: sectorAgg ? sectorAgg["avgForwardPe"] : null,
    // فقط اگر لازم است:
    // netMargin: calcDetails["netMargin"],
  };
}
