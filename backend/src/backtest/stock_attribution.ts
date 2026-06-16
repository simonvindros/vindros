import "dotenv/config";
/**
 * Stock Attribution Analysis
 *
 * Tracks every trade in the full strategy (90d window, last-day rebalance)
 * and reports per-stock performance ranked by AVERAGE RETURN % per trade,
 * not total SEK (which is biased toward later years with larger portfolio).
 *
 * Also shows: holding period, win rate, best/worst single trade per stock.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

const OUTPUT_FILE = path.join(__dirname, "stock_attribution_output.txt");

// ─── Config ──────────────────────────────────────────────────────────────────
const START_DATE = new Date("2006-07-01");
const END_DATE = new Date("2026-05-27");
const TOTAL_POSITIONS = 15;
const MAX_ADV_FRACTION = 0.1;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const BENCHMARK_ID = 638;
const REG_SHORT = 90;
const MIN_PRICE = 10;
const MIN_R2 = 0.6;
const SALARY_DAY = 23;
const LARGE_MID_MARKETS = [1, 2];
const SMALL_MARKETS = [3, 4, 5];

// Fundamental thresholds
const MIN_REVENUE_GROWTH = 10;
const MIN_REVENUE_MSEK = 50;
const MIN_OPERATING_MARGIN = 5;
const MIN_YEARS_DATA = 3;
const KPI_REVENUE_GROWTH = 94;
const KPI_OPERATING_MARGIN = 29;
const KPI_REVENUE = 53;

// ─── Types ───────────────────────────────────────────────────────────────────
type PriceRow = { date: Date; close: number; volume: number };
type Position = {
  instrumentId: number;
  entryPrice: number;
  entryDate: string;
  shares: number;
  pool: "large" | "small";
  entryCost: number;
};

type ClosedTrade = {
  instrumentId: number;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  pnlSek: number;
  holdingMonths: number;
  pool: "large" | "small";
};

// ─── KPI data stores ─────────────────────────────────────────────────────────
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
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }],
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
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }, { period: "asc" }],
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
    for (const arr of instMap.values()) {
      arr.sort((a, b) => a.key - b.key);
    }
  }
}

function latestAvailableQuarter(dateStr: string): {
  year: number;
  period: number;
} {
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
    if (revGrowthYears.length < MIN_YEARS_DATA) continue;

    const recent = revGrowthYears.slice(-5);
    const avgRevGrowth = recent.reduce((s, [, v]) => s + v, 0) / recent.length;
    if (avgRevGrowth < MIN_REVENUE_GROWTH) continue;

    const last4 = revGrowthYears.slice(-4);
    if (last4.filter(([, v]) => v < 0).length > 1) continue;
    if (recent.some(([, v]) => v > 200 || v < -30)) continue;

    const revenueMap = kpiMap.get(KPI_REVENUE);
    if (revenueMap) {
      const latest = [...revenueMap.entries()]
        .filter(([y]) => y <= asOfYear)
        .sort((a, b) => a[0] - b[0])
        .pop();
      if (latest && latest[1] < MIN_REVENUE_MSEK) continue;
    }

    const opMarginMap = kpiMap.get(KPI_OPERATING_MARGIN);
    if (!opMarginMap) continue;
    const opMargins = [...opMarginMap.entries()]
      .filter(([y]) => y <= asOfYear)
      .sort((a, b) => a[0] - b[0]);
    if (opMargins.length < MIN_YEARS_DATA) continue;
    const latestMargin = opMargins[opMargins.length - 1][1];
    if (latestMargin < MIN_OPERATING_MARGIN) continue;
    const olderMargin = opMargins[Math.max(0, opMargins.length - 4)][1];
    if (latestMargin - olderMargin < 0) continue;

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

    const margQ = instQ.get(KPI_OPERATING_MARGIN);
    if (margQ && margQ.length > 0) {
      const available = margQ.filter((x) => x.key <= cutoff);
      if (available.length > 0 && available[available.length - 1].value < 0)
        continue;
    }

    qualified.add(instId);
  }

  return qualified;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const output: string[] = [];
  const log = (msg = "") => {
    output.push(msg);
    console.log(msg);
  };

  log("STOCK ATTRIBUTION ANALYSIS (ranked by avg return % per trade)");
  log("=".repeat(75));
  log("");
  log("Loading data...");

  const largeMidInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: LARGE_MID_MARKETS }, countryId: 1 },
    select: { id: true, name: true, marketId: true },
  });
  const smallInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: SMALL_MARKETS }, countryId: 1 },
    select: { id: true, name: true, marketId: true },
  });

  // Load sectors for context
  const instrumentsWithSector = await prisma.instrument.findMany({
    where: { countryId: 1 },
    select: { id: true, sectorId: true },
  });
  const sectorByInst = new Map<number, number | null>(
    instrumentsWithSector.map((i) => [i.id, i.sectorId]),
  );

  const sectors = await prisma.sector.findMany({
    select: { sectorId: true, name: true },
  });
  const sectorNameMap = new Map<number, string>(
    sectors.map((s) => [s.sectorId, s.name]),
  );

  const largeMidIds = largeMidInstruments.map((i) => i.id);
  const smallIds = smallInstruments.map((i) => i.id);
  const allIds = [...largeMidIds, ...smallIds];
  const largeMidIdSet = new Set(largeMidIds);
  const nameMap = new Map<number, string>(
    [...largeMidInstruments, ...smallInstruments].map((i) => [i.id, i.name]),
  );

  await loadKpiData(smallIds);

  const warmupDate = new Date(START_DATE);
  warmupDate.setDate(warmupDate.getDate() - 150);

  const allPrices = await prisma.stockPrice.findMany({
    where: {
      instrumentId: { in: [...allIds, BENCHMARK_ID] },
      date: { gte: warmupDate, lte: END_DATE },
    },
    select: { instrumentId: true, date: true, close: true, volume: true },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  });

  const pricesByInstrument = new Map<number, PriceRow[]>();
  for (const p of allPrices) {
    if (!pricesByInstrument.has(p.instrumentId))
      pricesByInstrument.set(p.instrumentId, []);
    pricesByInstrument
      .get(p.instrumentId)!
      .push({ date: p.date, close: Number(p.close), volume: Number(p.volume) });
  }

  log(`  Loaded ${allPrices.length.toLocaleString()} price rows`);

  // Trading dates
  const benchPrices = pricesByInstrument.get(BENCHMARK_ID) || [];
  const tradingDates = benchPrices
    .filter((p) => p.date >= START_DATE && p.date <= END_DATE)
    .map((p) => p.date.toISOString().slice(0, 10));

  // Month-ends
  const monthEnds: string[] = [];
  for (let i = 0; i < tradingDates.length - 1; i++) {
    if (tradingDates[i].slice(0, 7) !== tradingDates[i + 1].slice(0, 7))
      monthEnds.push(tradingDates[i]);
  }
  if (tradingDates.length > 0)
    monthEnds.push(tradingDates[tradingDates.length - 1]);
  const monthEndSet = new Set(monthEnds);

  // Salary dates
  const monthsInRange = new Map<string, string[]>();
  for (const d of tradingDates) {
    const ym = d.slice(0, 7);
    if (!monthsInRange.has(ym)) monthsInRange.set(ym, []);
    monthsInRange.get(ym)!.push(d);
  }
  const salaryDates = new Set<string>();
  for (const [ym, days] of monthsInRange) {
    const cutoff = `${ym}-${String(SALARY_DAY).padStart(2, "0")}`;
    let salaryDate = days[0];
    for (const d of days) {
      if (d <= cutoff) salaryDate = d;
    }
    salaryDates.add(salaryDate);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
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
      } else {
        hi = mid - 1;
      }
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
      } else {
        hi = mid - 1;
      }
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
    const reg = linearRegression(slice.length >= 60 ? slice : []);
    if (reg.slope <= 0) return undefined;
    if (reg.r2 < MIN_R2) return undefined;
    return { slope: reg.slope * 252, r2: reg.r2 };
  };

  const getADV = (instId: number, dateStr: string): number => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return 0;
    const idx = getPriceIndex(instId, dateStr);
    if (idx < 20) return 0;
    let totalTurnover = 0;
    for (let i = idx - 19; i <= idx; i++) {
      totalTurnover += prices[i].close * prices[i].volume;
    }
    return totalTurnover / 20;
  };

  const getUnifiedTop = (
    dateStr: string,
    count: number,
    estimatedPositionSize: number,
    qualifiedSmall: Set<number>,
  ) => {
    type Candidate = {
      instrumentId: number;
      slope: number;
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
        pool: "large",
      });
    }

    for (const instId of qualifiedSmall) {
      const price = getPriceOnDate(instId, dateStr);
      if (!price || price < MIN_PRICE) continue;
      const adv = getADV(instId, dateStr);
      if (adv > 0 && estimatedPositionSize / adv > MAX_ADV_FRACTION) continue;
      const reg = getRegressionScore(instId, dateStr);
      if (!reg) continue;
      candidates.push({
        instrumentId: instId,
        slope: reg.slope,
        pool: "small",
      });
    }

    candidates.sort((a, b) => b.slope - a.slope);
    return candidates.slice(0, count);
  };

  // ─── Run backtest tracking individual trades ───────────────────────────────
  log("  Running backtest with trade tracking...");

  const closedTrades: ClosedTrade[] = [];
  let cash = INITIAL_CAPITAL;
  let totalContributed = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyKey = 0;

  for (const day of tradingDates) {
    if (salaryDates.has(day)) {
      cash += MONTHLY_CONTRIBUTION;
      totalContributed += MONTHLY_CONTRIBUTION;
    }

    const currentYear = parseInt(day.slice(0, 4));
    const currentMonth = parseInt(day.slice(5, 7));
    const currentQ = Math.ceil(currentMonth / 3);
    const qualifyKey = currentYear * 10 + currentQ;

    if (qualifyKey > lastQualifyKey) {
      const avail = latestAvailableQuarter(day);
      qualifiedSmallCaps = getQualifiedSmallCaps(
        smallIds,
        currentYear - 1,
        avail.year,
        avail.period,
      );
      lastQualifyKey = qualifyKey;
    }

    if (monthEndSet.has(day)) {
      let currentPV = cash;
      for (const pos of positions) {
        const p = getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
        currentPV += pos.shares * p;
      }
      const estPositionSize = currentPV / TOTAL_POSITIONS;

      const topCandidates = getUnifiedTop(
        day,
        TOTAL_POSITIONS,
        estPositionSize,
        qualifiedSmallCaps,
      );
      const targetIds = new Set(topCandidates.map((c) => c.instrumentId));

      // Sell positions not in top
      const keepPositions: Position[] = [];
      for (const pos of positions) {
        if (targetIds.has(pos.instrumentId)) {
          keepPositions.push(pos);
        } else {
          const price = getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
          const exitValue = price * pos.shares;
          const returnPct = (price / pos.entryPrice - 1) * 100;
          const entryMonth = pos.entryDate.slice(0, 7);
          const exitMonth = day.slice(0, 7);
          const holdingMonths =
            (parseInt(exitMonth.slice(0, 4)) -
              parseInt(entryMonth.slice(0, 4))) *
              12 +
            parseInt(exitMonth.slice(5, 7)) -
            parseInt(entryMonth.slice(5, 7));

          closedTrades.push({
            instrumentId: pos.instrumentId,
            entryDate: pos.entryDate,
            exitDate: day,
            entryPrice: pos.entryPrice,
            exitPrice: price,
            returnPct,
            pnlSek: exitValue - pos.entryCost,
            holdingMonths: Math.max(1, holdingMonths),
            pool: pos.pool,
          });

          cash += exitValue;
        }
      }
      positions = keepPositions;

      // Rebalance
      let pv = cash;
      for (const pos of positions) {
        pv +=
          (getPriceOnDate(pos.instrumentId, day) || pos.entryPrice) *
          pos.shares;
      }
      const targetPerStock = pv / Math.max(topCandidates.length, 1);

      // Trim overweight
      for (const pos of positions) {
        const price = getPriceOnDate(pos.instrumentId, day);
        if (!price) continue;
        const currentValue = pos.shares * price;
        if (currentValue > targetPerStock * 1.01) {
          const sellShares = Math.floor(
            (currentValue - targetPerStock) / price,
          );
          if (sellShares > 0) {
            cash += sellShares * price;
            pos.entryCost -= pos.entryCost * (sellShares / pos.shares);
            pos.shares -= sellShares;
          }
        }
      }

      // Top up underweight
      for (const pos of positions) {
        const price = getPriceOnDate(pos.instrumentId, day);
        if (!price) continue;
        const currentValue = pos.shares * price;
        if (currentValue < targetPerStock * 0.99) {
          const buyShares = Math.floor((targetPerStock - currentValue) / price);
          if (buyShares > 0 && cash >= buyShares * price) {
            cash -= buyShares * price;
            pos.entryCost += buyShares * price;
            pos.shares += buyShares;
          }
        }
      }

      // Buy new entries
      const heldIds = new Set(positions.map((p) => p.instrumentId));
      for (const c of topCandidates) {
        if (heldIds.has(c.instrumentId)) continue;
        const price = getPriceOnDate(c.instrumentId, day);
        if (!price) continue;
        const shares = Math.floor(Math.min(targetPerStock, cash) / price);
        if (shares === 0) continue;
        const cost = shares * price;
        positions.push({
          instrumentId: c.instrumentId,
          entryPrice: price,
          entryDate: day,
          shares,
          pool: c.pool,
          entryCost: cost,
        });
        cash -= cost;
      }
    }
  }

  // Close remaining positions at end date for attribution
  const lastDate = tradingDates[tradingDates.length - 1];
  for (const pos of positions) {
    const price = getPriceOnDate(pos.instrumentId, lastDate) || pos.entryPrice;
    const returnPct = (price / pos.entryPrice - 1) * 100;
    const entryMonth = pos.entryDate.slice(0, 7);
    const exitMonth = lastDate.slice(0, 7);
    const holdingMonths =
      (parseInt(exitMonth.slice(0, 4)) - parseInt(entryMonth.slice(0, 4))) *
        12 +
      parseInt(exitMonth.slice(5, 7)) -
      parseInt(entryMonth.slice(5, 7));

    closedTrades.push({
      instrumentId: pos.instrumentId,
      entryDate: pos.entryDate,
      exitDate: lastDate,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      returnPct,
      pnlSek: price * pos.shares - pos.entryCost,
      holdingMonths: Math.max(1, holdingMonths),
      pool: pos.pool,
    });
  }

  log(`  ${closedTrades.length} total trades recorded`);
  log("");

  // ─── Aggregate per stock ───────────────────────────────────────────────────
  type StockStats = {
    id: number;
    name: string;
    sector: string;
    pool: string;
    trades: number;
    avgReturnPct: number;
    medianReturnPct: number;
    totalReturnPct: number;
    winRate: number;
    avgHoldingMonths: number;
    bestTradePct: number;
    worstTradePct: number;
    firstEntry: string;
    lastExit: string;
  };

  const byStock = new Map<number, ClosedTrade[]>();
  for (const t of closedTrades) {
    if (!byStock.has(t.instrumentId)) byStock.set(t.instrumentId, []);
    byStock.get(t.instrumentId)!.push(t);
  }

  const stockStats: StockStats[] = [];
  for (const [id, trades] of byStock) {
    const returns = trades.map((t) => t.returnPct);
    returns.sort((a, b) => a - b);
    const median = returns[Math.floor(returns.length / 2)];
    const avg = returns.reduce((s, r) => s + r, 0) / returns.length;
    const wins = returns.filter((r) => r > 0).length;
    const avgHold =
      trades.reduce((s, t) => s + t.holdingMonths, 0) / trades.length;
    const sectorId = sectorByInst.get(id);
    const sectorName =
      sectorId != null ? sectorNameMap.get(sectorId) || "Unknown" : "Unknown";

    stockStats.push({
      id,
      name: nameMap.get(id) || `ID:${id}`,
      sector: sectorName,
      pool: trades[0].pool,
      trades: trades.length,
      avgReturnPct: avg,
      medianReturnPct: median,
      totalReturnPct: returns.reduce((s, r) => s + r, 0),
      winRate: (wins / trades.length) * 100,
      avgHoldingMonths: avgHold,
      bestTradePct: returns[returns.length - 1],
      worstTradePct: returns[0],
      firstEntry: trades.reduce(
        (e, t) => (t.entryDate < e ? t.entryDate : e),
        trades[0].entryDate,
      ),
      lastExit: trades.reduce(
        (e, t) => (t.exitDate > e ? t.exitDate : e),
        trades[0].exitDate,
      ),
    });
  }

  // ─── Output: Ranked by avg return % ────────────────────────────────────────
  const byAvgReturn = [...stockStats].sort(
    (a, b) => b.avgReturnPct - a.avgReturnPct,
  );

  log("TOP 20 STOCKS BY AVERAGE RETURN % PER TRADE");
  log("-".repeat(75));
  log(
    "  #   Stock                  Sector              Avg%   Med%   Win%  Trades  Avg Hold",
  );
  log("  " + "-".repeat(72));

  for (let i = 0; i < Math.min(20, byAvgReturn.length); i++) {
    const s = byAvgReturn[i];
    log(
      `  ${String(i + 1).padStart(2)}  ${s.name.padEnd(22)} ${s.sector.slice(0, 18).padEnd(18)} ${s.avgReturnPct.toFixed(1).padStart(6)}% ${s.medianReturnPct.toFixed(1).padStart(5)}% ${s.winRate.toFixed(0).padStart(5)}%  ${String(s.trades).padStart(4)}    ${s.avgHoldingMonths.toFixed(1).padStart(4)}mo`,
    );
  }

  log("");
  log("");
  log("BOTTOM 10 STOCKS BY AVERAGE RETURN % PER TRADE");
  log("-".repeat(75));
  log(
    "  #   Stock                  Sector              Avg%   Med%   Win%  Trades  Avg Hold",
  );
  log("  " + "-".repeat(72));

  const byAvgReturnAsc = [...stockStats].sort(
    (a, b) => a.avgReturnPct - b.avgReturnPct,
  );
  for (let i = 0; i < Math.min(10, byAvgReturnAsc.length); i++) {
    const s = byAvgReturnAsc[i];
    log(
      `  ${String(i + 1).padStart(2)}  ${s.name.padEnd(22)} ${s.sector.slice(0, 18).padEnd(18)} ${s.avgReturnPct.toFixed(1).padStart(6)}% ${s.medianReturnPct.toFixed(1).padStart(5)}% ${s.winRate.toFixed(0).padStart(5)}%  ${String(s.trades).padStart(4)}    ${s.avgHoldingMonths.toFixed(1).padStart(4)}mo`,
    );
  }

  // ─── Time distribution: are winners from different eras? ───────────────────
  log("");
  log("");
  log(
    "TEMPORAL DISTRIBUTION — When did the top 20 stocks generate their returns?",
  );
  log("-".repeat(75));

  for (let i = 0; i < Math.min(20, byAvgReturn.length); i++) {
    const s = byAvgReturn[i];
    log(
      `  ${s.name.padEnd(22)} ${s.firstEntry.slice(0, 7)} → ${s.lastExit.slice(0, 7)}  (${s.trades} trades, best: +${s.bestTradePct.toFixed(0)}%, worst: ${s.worstTradePct.toFixed(0)}%)`,
    );
  }

  // ─── Sector breakdown ──────────────────────────────────────────────────────
  log("");
  log("");
  log("SECTOR BREAKDOWN — Total P&L contribution by sector");
  log("-".repeat(75));

  const sectorPnL = new Map<
    string,
    { pnl: number; trades: number; stocks: number }
  >();
  for (const s of stockStats) {
    const existing = sectorPnL.get(s.sector) || {
      pnl: 0,
      trades: 0,
      stocks: 0,
    };
    const stockTrades = byStock.get(s.id)!;
    existing.pnl += stockTrades.reduce((sum, t) => sum + t.pnlSek, 0);
    existing.trades += s.trades;
    existing.stocks++;
    sectorPnL.set(s.sector, existing);
  }

  const totalPnL = [...sectorPnL.values()].reduce((s, x) => s + x.pnl, 0);
  const sectorsSorted = [...sectorPnL.entries()].sort(
    (a, b) => b[1].pnl - a[1].pnl,
  );

  log("  Sector                    P&L (SEK)       % of total  Stocks  Trades");
  log("  " + "-".repeat(68));
  for (const [sector, data] of sectorsSorted) {
    const pct = (data.pnl / totalPnL) * 100;
    log(
      `  ${sector.slice(0, 26).padEnd(26)} ${Math.round(data.pnl).toLocaleString("sv-SE").padStart(12)} SEK  ${pct.toFixed(1).padStart(6)}%    ${String(data.stocks).padStart(3)}     ${data.trades}`,
    );
  }

  // ─── Summary stats ─────────────────────────────────────────────────────────
  log("");
  log("");
  log("OVERALL TRADE STATISTICS");
  log("-".repeat(75));

  const allReturns = closedTrades.map((t) => t.returnPct);
  allReturns.sort((a, b) => a - b);
  const totalTrades = allReturns.length;
  const avgReturn = allReturns.reduce((s, r) => s + r, 0) / totalTrades;
  const medianReturn = allReturns[Math.floor(totalTrades / 2)];
  const winCount = allReturns.filter((r) => r > 0).length;
  const avgWin =
    allReturns.filter((r) => r > 0).reduce((s, r) => s + r, 0) / winCount || 0;
  const lossCount = allReturns.filter((r) => r <= 0).length;
  const avgLoss =
    allReturns.filter((r) => r <= 0).reduce((s, r) => s + r, 0) / lossCount ||
    0;

  log(`  Total trades:       ${totalTrades}`);
  log(`  Win rate:           ${((winCount / totalTrades) * 100).toFixed(1)}%`);
  log(`  Avg return/trade:   ${avgReturn.toFixed(1)}%`);
  log(`  Median return:      ${medianReturn.toFixed(1)}%`);
  log(`  Avg win:            +${avgWin.toFixed(1)}%`);
  log(`  Avg loss:           ${avgLoss.toFixed(1)}%`);
  log(`  Best single trade:  +${allReturns[totalTrades - 1].toFixed(1)}%`);
  log(`  Worst single trade: ${allReturns[0].toFixed(1)}%`);
  log(
    `  Avg holding period: ${(closedTrades.reduce((s, t) => s + t.holdingMonths, 0) / totalTrades).toFixed(1)} months`,
  );
  log(`  Unique stocks:      ${byStock.size}`);
  log("");

  // Write to file
  fs.writeFileSync(OUTPUT_FILE, output.join("\n"), "utf-8");
  console.log(`\nResults written to: ${OUTPUT_FILE}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
