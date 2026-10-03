/**
 * TSETMC Scraper — fetches real trading data from cdn.tsetmc.com
 *
 * Endpoints discovered and verified 2026-09-16:
 *   GET cdn.tsetmc.com/api/Instrument/GetInstrumentSearch/{q}
 *   GET cdn.tsetmc.com/api/Instrument/GetInstrumentInfo/{insCode}
 *   GET cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceInfo/{insCode}
 *   GET old.tsetmc.com/tsev2/data/MarketWatchInit.aspx
 *
 * No API key required. Respect rate limits via DELAY_MS.
 */

const TSETMC_BASE = process.env.TSETMC_BASE_URL ?? "https://cdn.tsetmc.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface InstrumentSearchItem {
  insCode: string;
  instrumentID: string;
  lVal30: string; // Persian name
  lVal18AFC: string; // Latin symbol / short code
  cIsin: string;
  zTitad: string; // Shares outstanding (string-encoded int)
}

export interface InstrumentInfoResponse {
  instrumentInfo?: {
    cIsin?: string;
    zTitad?: number;
    lastHEven?: number;
    sector?: { lSecVal?: string };
    eps?: {
      estimatedEPS?: string;
      baseEPS?: string;
      sectorPE?: number | null;
      psr?: number | null;
    };
  };
}

export interface ClosingPriceResponse {
  closingPriceInfo?: {
    pClosing?: number | string;
    pDrCotVal?: number | string;
    qTotTran5J?: number | string;
    qTotCap?: number | string;
    priceYesterday?: number | string;
    // Extended fields when available
    finalLastDate?: unknown[];
  };
}

function toNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/,/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`TSETMC ${res.status} at ${url}`);
  return res.json() as Promise<T>;
}

/** Search for a symbol → resolve insCode + metadata */
export async function searchInstrument(
  symbol: string,
): Promise<InstrumentSearchItem | null> {
  const data = await getJson<{ instrumentSearch?: InstrumentSearchItem[] }>(
    `${TSETMC_BASE}/api/Instrument/GetInstrumentSearch/${encodeURIComponent(symbol)}`,
  );
  const list = data.instrumentSearch ?? [];
  if (list.length === 0) return null;
  // Prefer exact Latin-symbol match, fall back to first result
  return list.find((i) => i.lVal18AFC === symbol) ?? list[0] ?? null;
}

export interface InstrumentSnapshot {
  symbol: string;
  name: string;
  sector: string;
  isin: string;
  zTitad: number; // shares outstanding
  estimatedEps: number | null;
  sectorPE: number | null;
  psr: number | null;
}

/** Fetch shares/sector/EPS for an insCode */
export async function fetchInstrumentInfo(
  insCode: string,
): Promise<InstrumentSnapshot | null> {
  const data = await getJson<InstrumentInfoResponse>(
    `${TSETMC_BASE}/api/Instrument/GetInstrumentInfo/${insCode}`,
  );
  const inst = data.instrumentInfo;
  if (!inst) return null;
  return {
    symbol: "",
    name: "",
    sector: inst.sector?.lSecVal ?? "",
    isin: inst.cIsin ?? "",
    zTitad: inst.zTitad ?? 0,
    estimatedEps: inst.eps?.estimatedEPS ? parseFloat(inst.eps.estimatedEPS) : null,
    sectorPE: inst.eps?.sectorPE ?? null,
    psr: inst.eps?.psr ?? null,
  };
}

export interface ClosingPriceSnapshot {
  lastPrice: number; // IRR (already in Rial)
  priceYesterday: number;
  volume: number; // shares
  value: number; // Rial trade value
  change: number;
  changePct: number;
}

/** Fetch current price + volume for an insCode */
export async function fetchClosingPrice(
  insCode: string,
): Promise<ClosingPriceSnapshot | null> {
  const data = await getJson<ClosingPriceResponse>(
    `${TSETMC_BASE}/api/ClosingPrice/GetClosingPriceInfo/${insCode}`,
  );
  const cp = data.closingPriceInfo;
  if (!cp) return null;
  const last = toNum(cp.pDrCotVal ?? cp.pClosing);
  const yesterday = toNum(cp.priceYesterday);
  const change = yesterday > 0 ? last - yesterday : 0;
  return {
    lastPrice: last,
    priceYesterday: yesterday,
    volume: toNum(cp.qTotTran5J),
    value: toNum(cp.qTotCap),
    change,
    changePct: yesterday > 0 ? (change / yesterday) * 100 : 0,
  };
}

export interface ResolvedInstrument {
  symbol: string;
  name: string;
  insCode: string;
  isin: string;
  sector: string;
  shares: number;
  estimatedEps: number | null;
  sectorPE: number | null;
  psr: number | null;
  lastPrice: number;
  volume: number;
  value: number;
  changePct: number;
}

/** Resolve a symbol to a full snapshot (search + info + price) in one call. */
export async function resolveSymbol(
  symbol: string,
  persianNameHint: string | null = null,
): Promise<ResolvedInstrument | null> {
  const hit = await searchInstrument(symbol);
  if (!hit) return null;

  const info = await fetchInstrumentInfo(hit.insCode);
  if (!info) return null;

  const cp = await fetchClosingPrice(hit.insCode);
  if (!cp || cp.lastPrice <= 0) return null;

  return {
    symbol,
    name: hit.lVal30 || persianNameHint || symbol,
    insCode: hit.insCode,
    isin: info.isin || hit.cIsin,
    sector: info.sector,
    shares: info.zTitad,
    estimatedEps: info.estimatedEps,
    sectorPE: info.sectorPE,
    psr: info.psr,
    lastPrice: cp.lastPrice,
    volume: cp.volume,
    value: cp.value,
    changePct: cp.changePct,
  };
}

export const tsetmc = {
  searchInstrument,
  fetchInstrumentInfo,
  fetchClosingPrice,
  resolveSymbol,
};
