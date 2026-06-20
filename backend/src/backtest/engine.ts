/**
 * Shared backtest engine — data loading, price helpers, qualification logic.
 * Used by stock_attribution, montecarlo, and montecarlo_random scripts.
 */
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

// ─── Configuration ───────────────────────────────────────────────────────────
export const START_DATE = new Date("2006-07-01");
export const END_DATE = new Date("2026-05-27");
export const MIN_POSITIONS = 3;
export const MAX_POSITIONS = 15;
export const MAX_ADV_FRACTION = 0.1;
export const INITIAL_CAPITAL = 20_000;
export const MONTHLY_CONTRIBUTION = 5_000;
export const BENCHMARK_ID = 638;
export const REG_SHORT = 60;
export const MIN_PRICE = 10;
export const MIN_R2 = 0.6;
export const SALARY_DAY = 23;
export const LARGE_MID_MARKETS = [1, 2];
export const SMALL_MARKETS = [3, 4, 5];

// Fundamental thresholds (small caps)
export const MIN_REVENUE_GROWTH = 10;
export const MIN_REVENUE_MSEK = 50;
export const KPI_REVENUE_GROWTH = 94;
export const KPI_OPERATING_MARGIN = 29;
export const KPI_REVENUE = 53;

// ─── Types ───────────────────────────────────────────────────────────────────
export type PriceRow = { date: Date; close: number; volume: number };
export type Position = {
  instrumentId: number;
  tradeId: number;
  name: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  pool: "large" | "small";
};

export type Candidate = {
  instrumentId: number;
  slope: number;
  r2: number;
  pool: "large" | "small";
};

export type Allocation = {
  instrumentId: number;
  tradeId: number;
  slope: number;
  r2: number;
  pool: "large" | "small";
  allocation: number;
  capped: boolean;
};

type KpiData = Map<number, Map<number, Map<number, number>>>;
type QKpiData = Map<number, Map<number, Array<{ key: number; value: number }>>>;

// ─── Engine State ────────────────────────────────────────────────────────────
export type EngineData = {
  pricesByInstrument: Map<number, PriceRow[]>;
  nameMap: Map<number, string>;
  largeMidIdSet: Set<number>;
  smallIds: number[];
  allIds: number[];
  aToBMap: Map<number, number>;
  bToAMap: Map<number, number>;
  tradingDates: string[];
  monthEnds: string[];
  monthEndSet: Set<string>;
  salaryDates: Set<string>;
  kpiData: KpiData;
  qKpiData: QKpiData;
  benchPrices: PriceRow[];
};

export async function loadEngineData(): Promise<EngineData> {
  const allDbInstruments = await prisma.instrument.findMany({
    select: { id: true, name: true, marketId: true },
  });

  // Build A→B substitution map
  const aToBMap = new Map<number, number>();
  const bToAMap = new Map<number, number>();
  const aShares = allDbInstruments.filter((i) => / A$/.test(i.name));
  for (const a of aShares) {
    const bName = a.name.replace(/ A$/, " B");
    const b = allDbInstruments.find((i) => i.name === bName);
    if (b) {
      aToBMap.set(a.id, b.id);
      bToAMap.set(b.id, a.id);
    }
  }

  const largeMidInstruments = allDbInstruments.filter(
    (i) => i.marketId !== null && LARGE_MID_MARKETS.includes(i.marketId),
  );
  const smallInstruments = allDbInstruments.filter(
    (i) => i.marketId !== null && SMALL_MARKETS.includes(i.marketId),
  );

  const allInstruments = [...largeMidInstruments, ...smallInstruments];
  const allIds = allInstruments.map((i) => i.id);
  const nameMap = new Map<number, string>(
    allDbInstruments.map((i) => [i.id, i.name]),
  );
  const smallIds = smallInstruments.map((i) => i.id);
  const largeMidIdSet = new Set(largeMidInstruments.map((i) => i.id));

  // Load KPI data
  const kpiData: KpiData = new Map();
  const kpiValues = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: smallIds },
      kpiId: { in: [KPI_REVENUE_GROWTH, KPI_OPERATING_MARGIN, KPI_REVENUE] },
      reportType: "year",
      priceType: "mean",
    },
    select: { instrumentId: true, kpiId: true, year: true, value: true },
  });
  for (const kv of kpiValues) {
    if (kv.value === null) continue;
    if (!kpiData.has(kv.instrumentId)) kpiData.set(kv.instrumentId, new Map());
    const instMap = kpiData.get(kv.instrumentId)!;
    if (!instMap.has(kv.kpiId)) instMap.set(kv.kpiId, new Map());
    instMap.get(kv.kpiId)!.set(kv.year, Number(kv.value));
  }

  const qKpiData: QKpiData = new Map();
  const qKpiValues = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: smallIds },
      kpiId: { in: [KPI_REVENUE_GROWTH, KPI_OPERATING_MARGIN] },
      reportType: "quarter",
      priceType: "mean",
    },
    select: {
      instrumentId: true,
      kpiId: true,
      year: true,
      period: true,
      value: true,
    },
  });
  for (const kv of qKpiValues) {
    if (kv.value === null) continue;
    if (!qKpiData.has(kv.instrumentId))
      qKpiData.set(kv.instrumentId, new Map());
    const instMap = qKpiData.get(kv.instrumentId)!;
    if (!instMap.has(kv.kpiId)) instMap.set(kv.kpiId, []);
    instMap
      .get(kv.kpiId)!
      .push({ key: kv.year * 10 + (kv.period ?? 0), value: Number(kv.value) });
  }
  for (const instMap of qKpiData.values()) {
    for (const arr of instMap.values()) arr.sort((a, b) => a.key - b.key);
  }

  // Load prices
  const bShareIds = [...new Set([...aToBMap.values()])];
  const allNeededIds = [...new Set([...allIds, ...bShareIds, BENCHMARK_ID])];
  const warmupDate = new Date(START_DATE);
  warmupDate.setDate(warmupDate.getDate() - 150);

  const allPrices = await prisma.stockPrice.findMany({
    where: {
      instrumentId: { in: allNeededIds },
      date: { gte: warmupDate, lte: END_DATE },
    },
    select: { instrumentId: true, date: true, close: true, volume: true },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  });

  const pricesByInstrument = new Map<number, PriceRow[]>();
  for (const p of allPrices) {
    if (!pricesByInstrument.has(p.instrumentId))
      pricesByInstrument.set(p.instrumentId, []);
    pricesByInstrument.get(p.instrumentId)!.push({
      date: p.date,
      close: Number(p.close),
      volume: Number(p.volume),
    });
  }

  const benchPrices = pricesByInstrument.get(BENCHMARK_ID) || [];
  const tradingDates = benchPrices
    .filter((p) => p.date >= START_DATE && p.date <= END_DATE)
    .map((p) => p.date.toISOString().slice(0, 10));

  const monthEnds: string[] = [];
  for (let i = 0; i < tradingDates.length - 1; i++) {
    if (tradingDates[i].slice(0, 7) !== tradingDates[i + 1].slice(0, 7))
      monthEnds.push(tradingDates[i]);
  }
  if (tradingDates.length > 0)
    monthEnds.push(tradingDates[tradingDates.length - 1]);
  const monthEndSet = new Set(monthEnds);

  const salaryDates = new Set<string>();
  const monthsInRange = new Map<string, string[]>();
  for (const d of tradingDates) {
    const ym = d.slice(0, 7);
    if (!monthsInRange.has(ym)) monthsInRange.set(ym, []);
    monthsInRange.get(ym)!.push(d);
  }
  for (const [ym, days] of monthsInRange) {
    const cutoff = `${ym}-${String(SALARY_DAY).padStart(2, "0")}`;
    let salaryDate = days[0];
    for (const d of days) {
      if (d <= cutoff) salaryDate = d;
    }
    salaryDates.add(salaryDate);
  }

  return {
    pricesByInstrument,
    nameMap,
    largeMidIdSet,
    smallIds,
    allIds,
    aToBMap,
    bToAMap,
    tradingDates,
    monthEnds,
    monthEndSet,
    salaryDates,
    kpiData,
    qKpiData,
    benchPrices,
  };
}

// ─── Price Helpers ───────────────────────────────────────────────────────────
export function getPriceOnDate(
  pricesByInstrument: Map<number, PriceRow[]>,
  instId: number,
  dateStr: string,
): number | undefined {
  const prices = pricesByInstrument.get(instId);
  if (!prices) return undefined;
  let lo = 0,
    hi = prices.length - 1,
    best: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid].date.toISOString().slice(0, 10) <= dateStr) {
      best = prices[mid].close;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function getPriceIndex(
  pricesByInstrument: Map<number, PriceRow[]>,
  instId: number,
  dateStr: string,
): number {
  const prices = pricesByInstrument.get(instId);
  if (!prices) return -1;
  let lo = 0,
    hi = prices.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid].date.toISOString().slice(0, 10) <= dateStr) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function getRegressionScore(
  pricesByInstrument: Map<number, PriceRow[]>,
  instId: number,
  dateStr: string,
): { slope: number; r2: number } | undefined {
  const prices = pricesByInstrument.get(instId);
  if (!prices) return undefined;
  const idx = getPriceIndex(pricesByInstrument, instId, dateStr);
  if (idx < REG_SHORT) return undefined;
  const lastPriceDate = prices[idx].date.toISOString().slice(0, 10);
  const daysDiff =
    (new Date(dateStr).getTime() - new Date(lastPriceDate).getTime()) /
    86400000;
  if (daysDiff > 7) return undefined;
  const closes = prices.map((p) => p.close);
  const slice = closes.slice(idx - REG_SHORT + 1, idx + 1);
  const reg = linearRegression(slice, Math.floor(REG_SHORT * 0.67));
  if (reg.slope <= 0 || reg.r2 < MIN_R2) return undefined;
  return { slope: reg.slope * 252, r2: reg.r2 };
}

export function getADV(
  pricesByInstrument: Map<number, PriceRow[]>,
  instId: number,
  dateStr: string,
): number {
  const prices = pricesByInstrument.get(instId);
  if (!prices) return 0;
  const idx = getPriceIndex(pricesByInstrument, instId, dateStr);
  if (idx < 20) return 0;
  let total = 0;
  for (let i = idx - 19; i <= idx; i++)
    total += prices[i].close * prices[i].volume;
  return total / 20;
}

export function getEffectiveADV(
  pricesByInstrument: Map<number, PriceRow[]>,
  aToBMap: Map<number, number>,
  instId: number,
  dateStr: string,
): { adv: number; tradeId: number } {
  const adv = getADV(pricesByInstrument, instId, dateStr);
  const bId = aToBMap.get(instId);
  if (bId) {
    const bAdv = getADV(pricesByInstrument, bId, dateStr);
    if (bAdv > adv) return { adv: bAdv, tradeId: bId };
  }
  return { adv, tradeId: instId };
}

// ─── Qualification ───────────────────────────────────────────────────────────
export function latestAvailableQuarter(dateStr: string) {
  const month = parseInt(dateStr.slice(5, 7));
  const year = parseInt(dateStr.slice(0, 4));
  const currentQ = Math.ceil(month / 3);
  if (currentQ === 1) return { year: year - 1, period: 4 };
  return { year, period: currentQ - 1 };
}

export function getQualifiedSmallCaps(
  kpiData: KpiData,
  qKpiData: QKpiData,
  instrumentIds: number[],
  asOfYear: number,
  asOfQuarterYear: number,
  asOfPeriod: number,
): Set<number> {
  const annualQualified = new Set<number>();
  for (const instId of instrumentIds) {
    const kpiMap = kpiData.get(instId);
    if (!kpiMap) continue;
    const revGrowthMap = kpiMap.get(KPI_REVENUE_GROWTH);
    if (!revGrowthMap) continue;
    const revGrowthYears = [...revGrowthMap.entries()]
      .filter(([y]) => y <= asOfYear)
      .sort((a, b) => a[0] - b[0]);
    if (revGrowthYears.length < 1) continue;
    const recent = revGrowthYears.slice(-5);
    const avgRevGrowth = recent.reduce((s, [, v]) => s + v, 0) / recent.length;
    if (avgRevGrowth < MIN_REVENUE_GROWTH) continue;
    const last4 = revGrowthYears.slice(-4);
    if (last4.filter(([, v]) => v < 0).length > 1) continue;
    let hasUnvalidatedSpike = false;
    for (let i = 0; i < recent.length; i++) {
      const [yr, v] = recent[i];
      if (v < -30) {
        hasUnvalidatedSpike = true;
        break;
      }
      if (v > 200) {
        const nextEntry = revGrowthYears.find(([y]) => y === yr + 1);
        if (!nextEntry || nextEntry[1] <= 20) {
          hasUnvalidatedSpike = true;
          break;
        }
      }
    }
    if (hasUnvalidatedSpike) continue;
    const revenueMap = kpiMap.get(KPI_REVENUE);
    if (revenueMap) {
      const latest = [...revenueMap.entries()]
        .filter(([y]) => y <= asOfYear)
        .sort((a, b) => a[0] - b[0])
        .pop();
      if (latest && latest[1] < MIN_REVENUE_MSEK) continue;
    }
    annualQualified.add(instId);
  }
  const cutoff = asOfQuarterYear * 10 + asOfPeriod;
  const qualified = new Set<number>();
  for (const instId of annualQualified) {
    const instQ = qKpiData.get(instId);
    if (!instQ) {
      qualified.add(instId);
      continue;
    }
    const revQ = instQ.get(KPI_REVENUE_GROWTH);
    if (revQ && revQ.length > 0) {
      const available = revQ.filter((x) => x.key <= cutoff);
      if (available.length > 0 && available[available.length - 1].value < -10)
        continue;
    }
    qualified.add(instId);
  }
  return qualified;
}

// ─── Candidate Selection ─────────────────────────────────────────────────────
export function getAllCandidates(
  data: EngineData,
  dateStr: string,
  qualifiedSmall: Set<number>,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const instId of data.largeMidIdSet) {
    const price = getPriceOnDate(data.pricesByInstrument, instId, dateStr);
    if (!price || price < MIN_PRICE) continue;
    const reg = getRegressionScore(data.pricesByInstrument, instId, dateStr);
    if (!reg) continue;
    candidates.push({
      instrumentId: instId,
      slope: reg.slope,
      r2: reg.r2,
      pool: "large",
    });
  }
  for (const instId of qualifiedSmall) {
    const price = getPriceOnDate(data.pricesByInstrument, instId, dateStr);
    if (!price || price < MIN_PRICE) continue;
    const reg = getRegressionScore(data.pricesByInstrument, instId, dateStr);
    if (!reg) continue;
    candidates.push({
      instrumentId: instId,
      slope: reg.slope,
      r2: reg.r2,
      pool: "small",
    });
  }
  candidates.sort((a, b) => b.slope - a.slope);

  // Deduplicate by company name (strip A/B suffix)
  const seenCompanies = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of candidates) {
    const rawName = data.nameMap.get(c.instrumentId) || String(c.instrumentId);
    const companyName = rawName.replace(/ [AB]$/, "");
    if (seenCompanies.has(companyName)) continue;
    seenCompanies.add(companyName);
    deduped.push(c);
  }
  return deduped;
}

// ─── Allocation ──────────────────────────────────────────────────────────────
export function allocatePositions(
  data: EngineData,
  candidates: Candidate[],
  portfolioValue: number,
  dateStr: string,
): { allocations: Allocation[]; expansionReason: string | null } {
  const targetPerSlot = portfolioValue / MIN_POSITIONS;
  const allocations: Allocation[] = [];
  let remaining = portfolioValue;
  let candidateIdx = 0;
  const usedTradeIds = new Set<number>();

  while (
    remaining > 100 &&
    candidateIdx < candidates.length &&
    candidateIdx < MAX_POSITIONS
  ) {
    const c = candidates[candidateIdx];
    candidateIdx++;

    const { adv, tradeId } = getEffectiveADV(
      data.pricesByInstrument,
      data.aToBMap,
      c.instrumentId,
      dateStr,
    );

    if (usedTradeIds.has(tradeId)) continue;
    if (usedTradeIds.has(c.instrumentId)) continue;
    const counterpartId =
      data.aToBMap.get(c.instrumentId) ?? data.bToAMap.get(c.instrumentId);
    if (counterpartId && usedTradeIds.has(counterpartId)) continue;

    const maxByLiquidity = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
    const idealAllocation = Math.min(targetPerSlot, remaining);
    const capped = idealAllocation > maxByLiquidity;
    const actualAllocation = Math.min(idealAllocation, maxByLiquidity);

    if (actualAllocation < 100) continue;

    allocations.push({
      instrumentId: c.instrumentId,
      tradeId,
      slope: c.slope,
      r2: c.r2,
      pool: c.pool,
      allocation: actualAllocation,
      capped,
    });

    usedTradeIds.add(tradeId);
    usedTradeIds.add(c.instrumentId);
    if (counterpartId) usedTradeIds.add(counterpartId);
    remaining -= actualAllocation;
  }

  // Pass 2: redistribute leftover
  let passes = 0;
  while (remaining > 100 && passes < 10) {
    passes++;
    const uncapped = allocations.filter((a) => {
      const { adv } = getEffectiveADV(
        data.pricesByInstrument,
        data.aToBMap,
        a.instrumentId,
        dateStr,
      );
      const maxByLiquidity = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
      return a.allocation < maxByLiquidity * 0.99;
    });
    if (uncapped.length === 0) break;

    const perStock = remaining / uncapped.length;
    let distributed = 0;
    for (const a of uncapped) {
      const { adv } = getEffectiveADV(
        data.pricesByInstrument,
        data.aToBMap,
        a.instrumentId,
        dateStr,
      );
      const maxByLiquidity = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
      const room = maxByLiquidity - a.allocation;
      const topUp = Math.min(perStock, room);
      if (topUp > 0) {
        a.allocation += topUp;
        distributed += topUp;
        if (a.allocation >= maxByLiquidity * 0.99) a.capped = true;
      }
    }
    remaining -= distributed;
    if (distributed < 100) break;
  }

  const reason =
    allocations.length > MIN_POSITIONS
      ? `${MIN_POSITIONS}→${allocations.length} slots (liquidity caps)`
      : null;

  return { allocations, expansionReason: reason };
}

export async function disconnect() {
  await prisma.$disconnect();
}
