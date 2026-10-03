/**
 * Bourse Radar — LLM Narrative Generation Service
 * Tehran Stock Exchange quantitative ranking engine
 *
 * Enforces: NO buy/sell signals. Only explains WHY a stock ranks as it does,
 * with explicit uncertainty disclosure. Uses Zod-structured output.
 */

import OpenAI from "openai";
import { z } from "zod";
import { config } from "#config";
import { logger } from "#utils/logger";

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
});

export type LlmNarrative = z.infer<typeof LlmNarrativeSchema>;

// ──────────────── JSON Extraction ────────────────────────

/**
 * Extract JSON from a possibly-messy LLM response.
 * Handles: raw JSON, ```json fences, and embedded JSON in prose.
 */
function extractJson(raw: string): unknown {
  // 1) Direct parse
  try {
    return JSON.parse(raw);
  } catch {
    /* continue */
  }

  // 2) ```json ... ``` fence
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* continue */
    }
  }

  // 3) First { to last }
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

// ──────────────── System Prompt (Persian) ─────────────────

const SYSTEM_PROMPT = `
شما یک تحلیل‌گر مالی عددی برای بازار سهام ایران (بورس تهران) هستید.
وظیفه شما تبیین این است که چرا یک سهم در رتبه خاصی قرار دارد — نه اینکه بگویید بخرید یا بفروشید.

قوانین سخت‌گیرانه:
1. فقط از داده‌های عددی ارائه‌شده در JSON استفاده کنید. هیچ حدسی نزنید.
2. اگر Forward P/E یا EPS غیرقابل محاسبه است، صراحتاً بگویید "قابل محاسبه نیست."
3. هرگز جهت‌گیری قیمتی پیش‌بینی نکنید. فقط توضیح دهید که چرا این سهم «ظاهراً جذاب» یا «پرریسک» است.
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
  "disclaimer": "بیانیه عدم‌اعتماد حداکثر ۳۰۰ کاراکتر"
}
`.trim();

const USER_PROMPT_TEMPLATE = `
در ادامه داده‌های عددی یک سهم از بورس تهران را می‌بینید. یک تحلیل کوتاه (۲ تا ۳ پاراگراف)
به زبان فارسی بنویس که توضیح دهد چرا این سهم در رتبه {{RANK}} از {{TOTAL}} قرار دارد.
دقیقاً بر اساس داده‌ها حرف بزنید — هیچ حدسی نداشته باشید. اگر داده‌ای کافی نیست، بگویید.

فقط JSON برگردان. بدون markdown، بدون متن اضافه.

ورودی JSON:
{{JSON_INPUT}}
`.trim();

// ──────────────── LLM Narrator Class ─────────────────────

export class LlmNarrator {
  private client: OpenAI;
  public modelName: string;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
    });
    this.modelName = config.llm.model;
  }

  async generate(stockInput: Record<string, unknown>): Promise<LlmNarrative> {
    const jsonInput = JSON.stringify(stockInput, null, 2);
    const userPrompt = USER_PROMPT_TEMPLATE.replace(
      "{{RANK}}",
      String(stockInput["rankingPosition"] ?? "?"),
    )
      .replace("{{TOTAL}}", String(stockInput["totalStocksRanked"] ?? "?"))
      .replace("{{JSON_INPUT}}", jsonInput);

    try {
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: config.llm.maxTokens,
        temperature: config.llm.temperature,
        response_format: { type: "json_object" },
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) throw new Error("Empty LLM response");

      // ← JSON extraction مقاوم
      const parsed = extractJson(raw) as Record<string, unknown>;

      // ← usage را از response بگیر، نه از parsed
      const result = LlmNarrativeSchema.parse({
        ...parsed,
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
      });

      return result;
    } catch (err) {
      logger.error(
        err,
        `LLM narrative generation failed for ${stockInput["symbol"] ?? "unknown"}`,
      );
      throw err;
    }
  }

  async generateBatch(
    stocks: Array<Record<string, unknown>>,
    sectorAggs?: Map<string, Record<string, unknown>>,
  ): Promise<
    Array<
      | LlmNarrative
      | {
          symbol: string;
          fallback: true;
          error: string;
          rawData: Record<string, unknown>;
        }
    >
  > {
    // ── concurrency limit: 2 هم‌زمان (جلوگیری از timeout) ──
    const CONCURRENCY = 2;
    const results: Array<PromiseSettledResult<LlmNarrative>> = new Array(
      stocks.length,
    );
    let cursor = 0;

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= stocks.length) return;
        const stock = stocks[i];
        if (!stock) continue;
        const input = {
          ...stock,
          sectorContext: sectorAggs?.get(stock["sector"] as string),
        };
        try {
          const value = await self.generate(input);
          results[i] = { status: "fulfilled", value };
        } catch (reason) {
          results[i] = { status: "rejected", reason };
        }
      }
    }

    const self = this;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, stocks.length) }, () =>
        worker(),
      ),
    );

    return results.map((r, i) => {
      if (r?.status === "fulfilled") return r.value;

      const stock = stocks[i];
      const symbol = (stock?.["symbol"] as string) ?? "unknown";
      const error =
        r?.status === "rejected"
          ? r.reason instanceof Error
            ? r.reason.message
            : String(r.reason)
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
  row: Record<string, unknown>,
  sectorAggs?: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
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