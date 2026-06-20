/**
 * VINDROS DYNAMIC — Concentrate hard, expand only when liquidity forces it.
 *
 * Start with 3 target positions. If any stock would exceed 10% of ADV,
 * expand to 4, then 5, etc. until all positions fit. A-shares automatically
 * substituted with B-shares for liquidity checks.
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

const OUTPUT_FILE = path.join(__dirname, "vindros_dynamic_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

// ─── Configuration ───────────────────────────────────────────────────────────
const START_DATE = new Date("2006-07-01");
const END_DATE = new Date("2026-05-27");
const MIN_POSITIONS = 3;
const MAX_POSITIONS = 15; // safety cap
const MAX_ADV_FRACTION = 0.1;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const BENCHMARK_ID = 638;
const REG_SHORT = 60;
const MIN_PRICE = 10;
const MIN_R2 = 0.6;
const SALARY_DAY = 23;

// ─── Configurable parameters (override via CLI args) ─────────────────────────
// Execution lag: how many trading days after signal before we buy (0 = same day)
const EXECUTION_LAG = parseInt(process.env.EXEC_LAG || "0", 10);
// Universe: which market IDs to use (default: all Swedish markets 1-5)
const LARGE_MID_MARKETS = (process.env.LARGE_MID_MARKETS || "1,2")
  .split(",")
  .map(Number);
const SMALL_MARKETS = (process.env.SMALL_MARKETS || "3,4,5")
  .split(",")
  .map(Number);

// Fundamental thresholds (small caps)
const MIN_REVENUE_GROWTH = 10;
const MIN_REVENUE_MSEK = 50;
const MIN_OPERATING_MARGIN = 5;
const MIN_YEARS_DATA = 2;
const KPI_REVENUE_GROWTH = 94;
const KPI_OPERATING_MARGIN = 29;
const KPI_REVENUE = 53;

// ─── Types ───────────────────────────────────────────────────────────────────
type PriceRow = { date: Date; close: number; volume: number };
type Position = {
  instrumentId: number;
  tradeId: number; // for B-share substitution tracking
  name: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  pool: "large" | "small";
};

type KpiData = Map<number, Map<number, Map<number, number>>>;
let kpiData: KpiData = new Map();
type QKpiData = Map<number, Map<number, Array<{ key: number; value: number }>>>;
let qKpiData: QKpiData = new Map();

async function loadKpiData(instrumentIds: number[]) {
  const kpiValues = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: instrumentIds },
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
  const qKpiValues = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: instrumentIds },
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
}

function latestAvailableQuarter(dateStr: string) {
  const month = parseInt(dateStr.slice(5, 7));
  const year = parseInt(dateStr.slice(0, 4));
  const currentQ = Math.ceil(month / 3);
  if (currentQ === 1) return { year: year - 1, period: 4 };
  return { year, period: currentQ - 1 };
}

function getQualifiedSmallCaps(
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
    // Outlier check: reject <-30% always; for >200% spikes, allow if next year grew >20%
    let hasUnvalidatedSpike = false;
    for (let i = 0; i < recent.length; i++) {
      const [yr, v] = recent[i];
      if (v < -30) {
        hasUnvalidatedSpike = true;
        break;
      }
      if (v > 200) {
        // Check if the year after the spike also grew >20% (sustained = legitimate)
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

// ─── Main ────────────────────────────────────────────────────────────────────
const run = async () => {
  log("═══ VINDROS DYNAMIC ═══");
  log(`Execution lag: ${EXECUTION_LAG} trading days`);
  log(
    `Universe: Large/Mid markets [${LARGE_MID_MARKETS}], Small markets [${SMALL_MARKETS}]`,
  );
  log("");

  // Load all instruments (including B-shares for substitution)
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
  log(`A→B substitution pairs: ${aToBMap.size}`);

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

  await loadKpiData(smallIds);

  // Also need prices for B-shares we might substitute into
  const bShareIds = [...new Set([...aToBMap.values()])];
  const allNeededIds = [...new Set([...allIds, ...bShareIds, BENCHMARK_ID])];

  const warmupDate = new Date(START_DATE);
  warmupDate.setDate(warmupDate.getDate() - 150);

  log("Loading prices...");
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

  // ─── Helpers ─────────────────────────────────────────────────────────────
  const getPriceOnDate = (
    instId: number,
    dateStr: string,
  ): number | undefined => {
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
  };

  const getPriceIndex = (instId: number, dateStr: string): number => {
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
  };

  const getRegressionScore = (instId: number, dateStr: string) => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return undefined;
    const idx = getPriceIndex(instId, dateStr);
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
  };

  // Get the price N trading days after a given date (for execution lag)
  const getLaggedPrice = (
    instId: number,
    dateStr: string,
    lagDays: number,
  ): number | undefined => {
    if (lagDays === 0) return getPriceOnDate(instId, dateStr);
    const prices = pricesByInstrument.get(instId);
    if (!prices) return undefined;
    const idx = getPriceIndex(instId, dateStr);
    if (idx < 0) return undefined;
    const targetIdx = idx + lagDays;
    if (targetIdx >= prices.length) return prices[prices.length - 1].close;
    return prices[targetIdx].close;
  };

  const getADV = (instId: number, dateStr: string): number => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return 0;
    const idx = getPriceIndex(instId, dateStr);
    if (idx < 20) return 0;
    let total = 0;
    for (let i = idx - 19; i <= idx; i++)
      total += prices[i].close * prices[i].volume;
    return total / 20;
  };

  // Get ADV considering A→B substitution: if A-share is illiquid, return B-share ADV
  const getEffectiveADV = (
    instId: number,
    dateStr: string,
  ): { adv: number; tradeId: number } => {
    const adv = getADV(instId, dateStr);
    const bId = aToBMap.get(instId);
    if (bId) {
      const bAdv = getADV(bId, dateStr);
      if (bAdv > adv) return { adv: bAdv, tradeId: bId };
    }
    return { adv, tradeId: instId };
  };

  // Get all candidates sorted by slope (NO ADV filter — that's handled dynamically)
  const getAllCandidates = (dateStr: string, qualifiedSmall: Set<number>) => {
    type Candidate = {
      instrumentId: number;
      slope: number;
      r2: number;
      pool: "large" | "small";
    };
    const candidates: Candidate[] = [];
    for (const instId of largeMidIdSet) {
      const price = getPriceOnDate(instId, dateStr);
      if (!price || price < MIN_PRICE) continue;
      const reg = getRegressionScore(instId, dateStr);
      if (!reg) continue;
      candidates.push({
        instrumentId: instId,
        slope: reg.slope,
        r2: reg.r2,
        pool: "large",
      });
    }
    for (const instId of qualifiedSmall) {
      const price = getPriceOnDate(instId, dateStr);
      if (!price || price < MIN_PRICE) continue;
      const reg = getRegressionScore(instId, dateStr);
      if (!reg) continue;
      candidates.push({
        instrumentId: instId,
        slope: reg.slope,
        r2: reg.r2,
        pool: "small",
      });
    }
    candidates.sort((a, b) => b.slope - a.slope);

    // Deduplicate by company name (strip A/B suffix, keep highest-slope entry)
    const seenCompanies = new Set<string>();
    const deduped: Candidate[] = [];
    for (const c of candidates) {
      const rawName = nameMap.get(c.instrumentId) || String(c.instrumentId);
      const companyName = rawName.replace(/ [AB]$/, "");
      if (seenCompanies.has(companyName)) continue;
      seenCompanies.add(companyName);
      deduped.push(c);
    }
    return deduped;
  };

  // ─── Dynamic slot allocation ────────────────────────────────────────────
  // Start with top 3. Allocate equal weight (pv/3) to each.
  // If a stock can't absorb its allocation (>10% of ADV), cap it at 10% ADV.
  // The leftover goes to the next ranked stock (#4), and so on.
  // Result: variable number of positions, 100% invested, no cash drag.
  type Allocation = {
    instrumentId: number;
    tradeId: number;
    slope: number;
    r2: number;
    pool: "large" | "small";
    allocation: number; // SEK to allocate
    capped: boolean;
  };

  const allocatePositions = (
    candidates: ReturnType<typeof getAllCandidates>,
    portfolioValue: number,
    dateStr: string,
  ): { allocations: Allocation[]; expansionReason: string | null } => {
    const targetPerSlot = portfolioValue / MIN_POSITIONS;
    const allocations: Allocation[] = [];
    let remaining = portfolioValue;
    let candidateIdx = 0;
    const usedTradeIds = new Set<number>(); // prevent A+B double-counting

    // Pass 1: allocate up to targetPerSlot each, capping at ADV limit
    while (
      remaining > 100 &&
      candidateIdx < candidates.length &&
      candidateIdx < MAX_POSITIONS
    ) {
      const c = candidates[candidateIdx];
      candidateIdx++;

      const { adv, tradeId } = getEffectiveADV(c.instrumentId, dateStr);

      // Skip if this company is already allocated (A↔B bidirectional check)
      if (usedTradeIds.has(tradeId)) continue;
      if (usedTradeIds.has(c.instrumentId)) continue;
      const counterpartId =
        aToBMap.get(c.instrumentId) ?? bToAMap.get(c.instrumentId);
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
      // Mark A↔B counterpart so the other share class can't sneak in
      if (counterpartId) usedTradeIds.add(counterpartId);

      remaining -= actualAllocation;
    }

    // Pass 2: if there's leftover cash (fewer candidates than slots, or all capped),
    // top up existing allocations proportionally, still respecting ADV caps.
    // Keep looping until remaining is negligible or no more room.
    let passes = 0;
    while (remaining > 100 && passes < 10) {
      passes++;
      const uncapped = allocations.filter((a) => {
        const { adv } = getEffectiveADV(a.instrumentId, dateStr);
        const maxByLiquidity = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
        return a.allocation < maxByLiquidity * 0.99;
      });
      if (uncapped.length === 0) break;

      const perStock = remaining / uncapped.length;
      let distributed = 0;
      for (const a of uncapped) {
        const { adv } = getEffectiveADV(a.instrumentId, dateStr);
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
      if (distributed < 100) break; // no progress
    }

    const reason =
      allocations.length > MIN_POSITIONS
        ? `${MIN_POSITIONS}→${allocations.length} slots (liquidity caps)`
        : null;

    return { allocations, expansionReason: reason };
  };

  // ─── Backtest Loop ─────────────────────────────────────────────────────
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let totalContributed = INITIAL_CAPITAL;
  let benchmarkShares =
    INITIAL_CAPITAL / (getPriceOnDate(BENCHMARK_ID, tradingDates[0]) || 1);

  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyYear = 0;
  let monthCount = 0;
  let totalTrades = 0;

  // Track yearly data
  type YearSnapshot = {
    year: number;
    portfolioValue: number;
    bmValue: number;
    contributed: number;
  };
  const yearSnapshots: YearSnapshot[] = [];
  let lastSnapshotYear = 0;
  let prevYearEndPV = INITIAL_CAPITAL;
  let prevYearEndBM = INITIAL_CAPITAL;
  let prevYearEndContrib = INITIAL_CAPITAL;

  // Track slot count changes
  const slotHistory: {
    month: number;
    date: string;
    slots: number;
    reason: string | null;
  }[] = [];

  // Track max drawdown
  let peakPV = INITIAL_CAPITAL;
  let maxDrawdown = 0;

  for (const day of tradingDates) {
    if (salaryDates.has(day)) {
      cash += MONTHLY_CONTRIBUTION;
      totalContributed += MONTHLY_CONTRIBUTION;
      const bmPrice = getPriceOnDate(BENCHMARK_ID, day);
      if (bmPrice) benchmarkShares += MONTHLY_CONTRIBUTION / bmPrice;
    }

    const currentYear = parseInt(day.slice(0, 4));
    const currentMonth = parseInt(day.slice(5, 7));
    const currentQ = Math.ceil(currentMonth / 3);
    const qualifyKey = currentYear * 10 + currentQ;
    if (qualifyKey > lastQualifyYear) {
      const avail = latestAvailableQuarter(day);
      qualifiedSmallCaps = getQualifiedSmallCaps(
        smallIds,
        currentYear - 1,
        avail.year,
        avail.period,
      );
      lastQualifyYear = qualifyKey;
    }

    if (monthEndSet.has(day)) {
      monthCount++;

      // Current portfolio value (sell everything conceptually, then reallocate)
      let currentPV = cash;
      for (const pos of positions) {
        const p = getPriceOnDate(pos.tradeId, day) || pos.entryPrice;
        currentPV += pos.shares * p;
      }

      // Get all candidates and allocate with liquidity caps
      const allCandidates = getAllCandidates(day, qualifiedSmallCaps);
      const { allocations, expansionReason } = allocatePositions(
        allCandidates,
        currentPV,
        day,
      );
      const slotCount = allocations.length;

      slotHistory.push({
        month: monthCount,
        date: day,
        slots: slotCount,
        reason: expansionReason,
      });

      const allSelectedSignalIds = new Set(
        allocations.map((a) => a.instrumentId),
      );

      // Determine sells
      const sells: { name: string; pool: string; returnPct: string }[] = [];
      const keepPositions: Position[] = [];
      for (const pos of positions) {
        if (allSelectedSignalIds.has(pos.instrumentId)) {
          keepPositions.push(pos);
        } else {
          const price = getPriceOnDate(pos.tradeId, day);
          if (price) {
            const ret = (price / pos.entryPrice - 1) * 100;
            sells.push({
              name: nameMap.get(pos.tradeId) || pos.name,
              pool: pos.pool,
              returnPct: `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`,
            });
            cash += price * pos.shares;
            totalTrades++;
          }
        }
      }
      positions = keepPositions;

      // Determine buys
      const heldSignalIds = new Set(positions.map((p) => p.instrumentId));
      const buys: {
        name: string;
        tradeName: string;
        pool: string;
        slope: number;
        rank: number;
        capped: boolean;
        allocation: number;
      }[] = [];
      for (let i = 0; i < allocations.length; i++) {
        const a = allocations[i];
        if (!heldSignalIds.has(a.instrumentId)) {
          buys.push({
            name: nameMap.get(a.instrumentId) || "",
            tradeName:
              a.tradeId !== a.instrumentId ? nameMap.get(a.tradeId) || "" : "",
            pool: a.pool,
            slope: a.slope,
            rank: i + 1,
            capped: a.capped,
            allocation: a.allocation,
          });
        }
      }

      // Rebalance existing positions to their target allocations
      const allocationMap = new Map(
        allocations.map((a) => [a.instrumentId, a]),
      );
      for (const pos of positions) {
        const alloc = allocationMap.get(pos.instrumentId);
        if (!alloc) continue;
        const price = getPriceOnDate(pos.tradeId, day);
        if (!price) continue;
        const currentValue = pos.shares * price;
        const target = alloc.allocation;
        if (currentValue > target * 1.01) {
          const sellShares = Math.floor((currentValue - target) / price);
          if (sellShares > 0) {
            cash += sellShares * price;
            pos.shares -= sellShares;
          }
        } else if (currentValue < target * 0.99) {
          const buyShares = Math.floor((target - currentValue) / price);
          if (buyShares > 0 && cash >= buyShares * price) {
            cash -= buyShares * price;
            pos.shares += buyShares;
          }
        }
      }

      // Buy new entries at their allocated amount (with execution lag)
      for (const a of allocations) {
        if (heldSignalIds.has(a.instrumentId)) continue;
        const price = getLaggedPrice(a.tradeId, day, EXECUTION_LAG);
        if (!price) continue;
        const shares = Math.floor(Math.min(a.allocation, cash) / price);
        if (shares === 0) continue;
        positions.push({
          instrumentId: a.instrumentId,
          tradeId: a.tradeId,
          name: nameMap.get(a.instrumentId) || "",
          entryDate: day,
          entryPrice: price,
          shares,
          pool: a.pool,
        });
        cash -= shares * price;
        totalTrades++;
      }

      // ─── LOG ─────────────────────────────────────────────────────────
      let portfolioValue = cash;
      for (const pos of positions) {
        portfolioValue +=
          (getPriceOnDate(pos.tradeId, day) || pos.entryPrice) * pos.shares;
      }
      const bmValue =
        benchmarkShares * (getPriceOnDate(BENCHMARK_ID, day) || 0);

      // Drawdown tracking
      if (portfolioValue > peakPV) peakPV = portfolioValue;
      const dd = ((peakPV - portfolioValue) / peakPV) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;

      // Year tracking
      if (currentYear > lastSnapshotYear && lastSnapshotYear > 0) {
        yearSnapshots.push({
          year: lastSnapshotYear,
          portfolioValue: prevYearEndPV,
          bmValue: prevYearEndBM,
          contributed: prevYearEndContrib,
        });
      }
      lastSnapshotYear = currentYear;
      prevYearEndPV = portfolioValue;
      prevYearEndBM = bmValue;
      prevYearEndContrib = totalContributed;

      const slotsLabel = expansionReason
        ? `${slotCount} slots (${expansionReason})`
        : `${slotCount} slots`;

      log("");
      log("━".repeat(80));
      log(
        `MONTH ${monthCount} — ${day}   PV: ${Math.round(portfolioValue).toLocaleString("sv-SE")} SEK   BM: ${Math.round(bmValue).toLocaleString("sv-SE")} SEK   ${slotsLabel}`,
      );
      log("━".repeat(80));

      if (sells.length > 0 || buys.length > 0) {
        if (sells.length > 0) {
          log("  SOLD:");
          for (const s of sells)
            log(
              `    ✗ ${s.name.padEnd(28)} [${s.pool}] ${s.returnPct.padStart(7)}`,
            );
        }
        if (buys.length > 0) {
          log("  BOUGHT:");
          for (const b of buys) {
            const sub = b.tradeName ? ` → trade ${b.tradeName}` : "";
            const cap = b.capped ? " [CAPPED]" : "";
            log(
              `    ✓ ${b.name.padEnd(28)} [${b.pool}] #${b.rank} slope:${b.slope.toFixed(2)}${sub}${cap}`,
            );
          }
        }
      } else {
        log("  No changes.");
      }

      // Holdings
      log("");
      log("  HOLDINGS:");
      for (let i = 0; i < allocations.length; i++) {
        const a = allocations[i];
        const pos = positions.find((p) => p.instrumentId === a.instrumentId);
        const price = getPriceOnDate(a.tradeId, day) || 0;
        const value = pos ? pos.shares * price : 0;
        const weight = ((value / portfolioValue) * 100).toFixed(1);
        const adv = getADV(a.tradeId, day);
        const pctOfAdv = adv > 0 ? ((value / adv) * 100).toFixed(1) : "N/A";
        const advStr =
          adv >= 1e6
            ? `${(adv / 1e6).toFixed(1)}M`
            : `${(adv / 1e3).toFixed(0)}k`;
        const tradeName =
          a.tradeId !== a.instrumentId
            ? nameMap.get(a.tradeId) || "?"
            : nameMap.get(a.instrumentId) || "";
        const held = pos ? `since ${pos.entryDate}` : "new";
        const ret = pos
          ? `${((price / pos.entryPrice - 1) * 100).toFixed(1)}%`
          : "";
        const capLabel = a.capped ? " ◄CAP" : "";
        const displayName = tradeName.padEnd(40);
        log(
          `    ${String(i + 1).padStart(2)}. ${displayName.padEnd(40)} ${price.toFixed(1).padStart(8)} SEK  slope:${a.slope.toFixed(2).padStart(6)}  wt:${weight}%  ADV:${advStr} (${pctOfAdv}%)  ${held} ${ret}${capLabel}`,
        );
      }

      const cashPct = ((cash / portfolioValue) * 100).toFixed(1);
      log(
        `  CASH: ${Math.round(cash).toLocaleString("sv-SE")} SEK (${cashPct}%)`,
      );
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  yearSnapshots.push({
    year: lastSnapshotYear,
    portfolioValue: prevYearEndPV,
    bmValue: prevYearEndBM,
    contributed: prevYearEndContrib,
  });

  const lastDate = tradingDates[tradingDates.length - 1];
  let finalValue = cash;
  for (const pos of positions) {
    finalValue +=
      (getPriceOnDate(pos.tradeId, lastDate) || pos.entryPrice) * pos.shares;
  }
  const totalReturn = (finalValue / totalContributed - 1) * 100;
  const benchFinal =
    benchmarkShares * (getPriceOnDate(BENCHMARK_ID, lastDate) || 0);
  const benchReturn = (benchFinal / totalContributed - 1) * 100;

  log("");
  log("═".repeat(80));
  log("SUMMARY");
  log("═".repeat(80));
  log(`  Months:         ${monthCount}`);
  log(`  Contributed:    ${totalContributed.toLocaleString("sv-SE")} SEK`);
  log(
    `  Final value:    ${Math.round(finalValue).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  Return:         ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(1)}%`,
  );
  log(
    `  Benchmark:      ${benchReturn >= 0 ? "+" : ""}${benchReturn.toFixed(1)}%`,
  );
  log(
    `  ALPHA:          ${totalReturn - benchReturn >= 0 ? "+" : ""}${(totalReturn - benchReturn).toFixed(1)}%`,
  );
  log(`  Max drawdown:   ${maxDrawdown.toFixed(1)}%`);
  log(`  Total trades:   ${totalTrades}`);

  // Slot count distribution
  const slotDist = new Map<number, number>();
  for (const s of slotHistory)
    slotDist.set(s.slots, (slotDist.get(s.slots) || 0) + 1);
  log("");
  log("  SLOT COUNT DISTRIBUTION:");
  for (const [slots, count] of [...slotDist.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const pct = ((count / slotHistory.length) * 100).toFixed(0);
    log(`    ${slots} slots: ${count} months (${pct}%)`);
  }

  // When did expansion happen?
  const expansions = slotHistory.filter((s) => s.reason);
  if (expansions.length > 0) {
    log("");
    log("  EXPANSION EVENTS:");
    for (const e of expansions) {
      log(`    Month ${e.month} (${e.date}): ${e.slots} slots — ${e.reason}`);
    }
  }

  // Annual breakdown
  log("");
  log("  ANNUAL BREAKDOWN:");
  log("  ─────────────────────────────────────────────────────────────");
  log("  Year     Portfolio    Benchmark    Alpha");
  log("  ─────────────────────────────────────────────────────────────");
  for (let i = 0; i < yearSnapshots.length; i++) {
    const snap = yearSnapshots[i];
    const prevPV =
      i === 0 ? INITIAL_CAPITAL : yearSnapshots[i - 1].portfolioValue;
    const prevBM = i === 0 ? INITIAL_CAPITAL : yearSnapshots[i - 1].bmValue;
    const contribThisYear =
      snap.contributed -
      (i === 0 ? INITIAL_CAPITAL : yearSnapshots[i - 1].contributed);
    const pReturn =
      ((snap.portfolioValue - prevPV - contribThisYear) /
        (prevPV + contribThisYear / 2)) *
      100;
    const bReturn =
      ((snap.bmValue - prevBM - contribThisYear) /
        (prevBM + contribThisYear / 2)) *
      100;
    const alpha = pReturn - bReturn;
    const yearLabel =
      i === yearSnapshots.length - 1 ? `${snap.year}*` : `${snap.year}`;
    log(
      `  ${yearLabel.padEnd(7)}  ${`${pReturn >= 0 ? "+" : ""}${pReturn.toFixed(1)}%`.padStart(10)}  ${`${bReturn >= 0 ? "+" : ""}${bReturn.toFixed(1)}%`.padStart(11)}  ${`${alpha >= 0 ? "+" : ""}${alpha.toFixed(1)}%`.padStart(8)}`,
    );
  }
  log("  (* partial year)");

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`\nOutput: ${OUTPUT_FILE}`);
  await prisma.$disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
