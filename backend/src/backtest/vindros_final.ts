/**
 * VINDROS UNIFIED — Single Pool
 *
 * 15 positions from ALL eligible stocks, ranked by slope.
 * Large/Mid Cap: always eligible (just need positive slope + min price).
 * Small/FN/Spotlight: must pass quality gate (revenue growth, margins) to be eligible.
 * Once eligible, everyone competes head-to-head on momentum.
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

const OUTPUT_FILE = path.join(__dirname, "vindros_final_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

// ─── Configuration ───────────────────────────────────────────────────────────
const START_DATE = new Date("2006-07-01");
const END_DATE = new Date("2026-05-27");
const TOTAL_POSITIONS = 15;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const BENCHMARK_ID = 638;
const REG_SHORT = 90;
const MIN_PRICE = 10;
const SALARY_DAY = 23;
const MAX_ADV_FRACTION = 0.1; // Position must be <10% of 20-day avg daily turnover
const ADV_LOOKBACK = 20; // 20 trading days for ADV calculation
const MIN_R2 = 0.6; // Minimum R² — exclude choppy trends

// Markets
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
  name: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  pool: "large" | "small";
};
type ClosedTrade = {
  instrumentId: number;
  name: string;
  entryDate: string;
  exitDate: string;
  holdDays: number;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  returnPct: number;
  pool: "large" | "small";
};

// ─── Quarterly Helper ────────────────────────────────────────────────────────
function latestAvailableQuarter(dateStr: string): {
  year: number;
  period: number;
} {
  const month = Number.parseInt(dateStr.slice(5, 7));
  const year = Number.parseInt(dateStr.slice(0, 4));
  const currentQ = Math.ceil(month / 3);
  // 1 quarter reporting lag
  if (currentQ === 1) return { year: year - 1, period: 4 };
  return { year, period: currentQ - 1 };
}

// ─── Fundamental Filter (Annual baseline + Quarterly freshness check) ────────
async function getQualifiedSmallCaps(
  instrumentIds: number[],
  asOfYear: number,
  asOfQuarterYear: number,
  asOfPeriod: number,
): Promise<Set<number>> {
  // 1) Annual baseline qualification
  const annualKpis = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: instrumentIds },
      kpiId: { in: [KPI_REVENUE_GROWTH, KPI_OPERATING_MARGIN, KPI_REVENUE] },
      reportType: "year",
      priceType: "mean",
    },
    select: { instrumentId: true, kpiId: true, year: true, value: true },
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }],
  });

  const data = new Map<number, Map<number, Map<number, number>>>();
  for (const kv of annualKpis) {
    if (kv.value === null) continue;
    if (!data.has(kv.instrumentId)) data.set(kv.instrumentId, new Map());
    const instMap = data.get(kv.instrumentId)!;
    if (!instMap.has(kv.kpiId)) instMap.set(kv.kpiId, new Map());
    instMap.get(kv.kpiId)!.set(kv.year, Number(kv.value));
  }

  const annualQualified = new Set<number>();

  for (const [instId, kpiMap] of data) {
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

  // 2) Quarterly freshness check: disqualify if latest quarter deteriorates
  const quarterlyKpis = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: [...annualQualified] },
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

  const cutoff = asOfQuarterYear * 10 + asOfPeriod;
  const qData = new Map<
    number,
    Map<number, Array<{ key: number; value: number }>>
  >();
  for (const kv of quarterlyKpis) {
    if (kv.value === null) continue;
    const key = kv.year * 10 + (kv.period ?? 0);
    if (key > cutoff) continue;
    if (!qData.has(kv.instrumentId)) qData.set(kv.instrumentId, new Map());
    const instMap = qData.get(kv.instrumentId)!;
    if (!instMap.has(kv.kpiId)) instMap.set(kv.kpiId, []);
    instMap.get(kv.kpiId)!.push({ key, value: Number(kv.value) });
  }

  const qualified = new Set<number>();

  for (const instId of annualQualified) {
    const instQ = qData.get(instId);

    // If no quarterly data available yet, pass on annual alone
    if (!instQ) {
      qualified.add(instId);
      continue;
    }

    // Freshness check 1: latest quarter revenue growth must not be deeply negative
    const revQ = instQ.get(KPI_REVENUE_GROWTH);
    if (revQ && revQ.length > 0) {
      revQ.sort((a, b) => a.key - b.key);
      const latestRevGrowth = revQ[revQ.length - 1].value;
      if (latestRevGrowth < -10) continue;
    }

    // Freshness check 2: latest quarter operating margin must not be negative
    const margQ = instQ.get(KPI_OPERATING_MARGIN);
    if (margQ && margQ.length > 0) {
      margQ.sort((a, b) => a.key - b.key);
      const latestMargin = margQ[margQ.length - 1].value;
      if (latestMargin < 0) continue;
    }

    qualified.add(instId);
  }

  return qualified;
}

// ─── Main ────────────────────────────────────────────────────────────────────
const run = async () => {
  const largeMidInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: LARGE_MID_MARKETS }, countryId: 1 },
    select: { id: true, name: true },
  });
  const smallInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: SMALL_MARKETS }, countryId: 1 },
    select: { id: true, name: true },
  });

  const allInstruments = [...largeMidInstruments, ...smallInstruments];
  const allIds = allInstruments.map((i) => i.id);
  const nameMap = new Map<number, string>(
    allInstruments.map((i) => [i.id, i.name]),
  );
  const smallIds = smallInstruments.map((i) => i.id);
  const largeMidIdSet = new Set(largeMidInstruments.map((i) => i.id));

  log(`Large/Mid Cap: ${largeMidInstruments.length} (always eligible)`);
  log(
    `Small/FN/Spotlight: ${smallInstruments.length} (must pass quality gate)`,
  );
  log(`Total slots: ${TOTAL_POSITIONS} (unified ranking by slope)`);

  // Load prices
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

  log(`Loaded ${allPrices.length} price rows.\n`);

  // Trading days
  const benchPrices = pricesByInstrument.get(BENCHMARK_ID) || [];
  const tradingDates = benchPrices
    .filter((p) => p.date >= START_DATE && p.date <= END_DATE)
    .map((p) => p.date.toISOString().slice(0, 10));

  // Rebalance = last trading day of month
  const rebalanceDates: string[] = [];
  for (let i = 0; i < tradingDates.length - 1; i++) {
    if (tradingDates[i].slice(0, 7) !== tradingDates[i + 1].slice(0, 7))
      rebalanceDates.push(tradingDates[i]);
  }
  if (tradingDates.length > 0)
    rebalanceDates.push(tradingDates[tradingDates.length - 1]);
  const rebalanceSet = new Set(rebalanceDates);

  // Salary dates
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

  // Helpers
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

    // Stale price guard: if the last available price is more than 7 calendar days
    // before the target date, the stock is no longer trading — skip it.
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
    if (idx < ADV_LOOKBACK) return 0;
    let totalTurnover = 0;
    for (let i = idx - ADV_LOOKBACK + 1; i <= idx; i++) {
      totalTurnover += prices[i].close * prices[i].volume;
    }
    return totalTurnover / ADV_LOOKBACK;
  };

  let liquidityFiltered = 0;

  const getUnifiedTop = (
    dateStr: string,
    count: number,
    estimatedPositionSize: number,
    qualifiedSmall: Set<number>,
  ) => {
    type Candidate = {
      instrumentId: number;
      slope: number;
      r2: number;
      pool: "large" | "small";
    };
    const candidates: Candidate[] = [];

    // Large/Mid: always eligible
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

    // Small: only if qualified through fundamental gate
    for (const instId of qualifiedSmall) {
      const price = getPriceOnDate(instId, dateStr);
      if (!price || price < MIN_PRICE) continue;
      // Liquidity filter on small caps
      const adv = getADV(instId, dateStr);
      if (adv > 0 && estimatedPositionSize / adv > MAX_ADV_FRACTION) {
        liquidityFiltered++;
        continue;
      }
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
    return candidates.slice(0, count);
  };

  // ─── Backtest ──────────────────────────────────────────────────────────
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let totalContributed = INITIAL_CAPITAL;
  let benchmarkShares =
    INITIAL_CAPITAL / (getPriceOnDate(BENCHMARK_ID, tradingDates[0]) || 1);
  const closedTrades: ClosedTrade[] = [];
  const dailyValues: { date: string; value: number }[] = [];

  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyYear = 0;

  for (const day of tradingDates) {
    // Salary
    if (salaryDates.has(day)) {
      cash += MONTHLY_CONTRIBUTION;
      totalContributed += MONTHLY_CONTRIBUTION;
      const bmPrice = getPriceOnDate(BENCHMARK_ID, day);
      if (bmPrice) benchmarkShares += MONTHLY_CONTRIBUTION / bmPrice;
    }

    // Quarterly re-qualification
    const currentYear = Number.parseInt(day.slice(0, 4));
    const currentMonth = Number.parseInt(day.slice(5, 7));
    const currentQ = Math.ceil(currentMonth / 3);
    const qualifyKey = currentYear * 10 + currentQ;

    if (qualifyKey > lastQualifyYear) {
      const avail = latestAvailableQuarter(day);
      qualifiedSmallCaps = await getQualifiedSmallCaps(
        smallIds,
        currentYear - 1,
        avail.year,
        avail.period,
      );
      lastQualifyYear = qualifyKey;
      log(
        `Q${currentQ} ${currentYear}: ${qualifiedSmallCaps.size} small caps qualified`,
      );
    }

    // Monthly rebalance
    if (rebalanceSet.has(day)) {
      // Estimate position size from current portfolio value
      let currentPV = cash;
      for (const pos of positions) {
        const p = getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
        currentPV += pos.shares * p;
      }
      const estPositionSize = currentPV / TOTAL_POSITIONS;

      // Unified pool: all eligible stocks compete for all slots
      const topCandidates = getUnifiedTop(
        day,
        TOTAL_POSITIONS,
        estPositionSize,
        qualifiedSmallCaps,
      );

      const allCandidateIds = new Set(topCandidates.map((c) => c.instrumentId));

      // Sell positions not in new targets
      const keepPositions: Position[] = [];
      for (const pos of positions) {
        if (allCandidateIds.has(pos.instrumentId)) {
          keepPositions.push(pos);
        } else {
          const price = getPriceOnDate(pos.instrumentId, day);
          if (price) {
            cash += price * pos.shares;
            const holdDays = Math.round(
              (new Date(day).getTime() - new Date(pos.entryDate).getTime()) /
                86400000,
            );
            closedTrades.push({
              instrumentId: pos.instrumentId,
              name: pos.name,
              pool: pos.pool,
              entryDate: pos.entryDate,
              exitDate: day,
              holdDays,
              entryPrice: pos.entryPrice,
              exitPrice: price,
              shares: pos.shares,
              pnl: (price - pos.entryPrice) * pos.shares,
              returnPct: (price / pos.entryPrice - 1) * 100,
            });
          }
        }
      }
      positions = keepPositions;

      // Rebalance to equal weight across ALL positions
      const totalSlots = topCandidates.length;
      let pv = cash;
      for (const pos of positions) {
        const p = getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
        pv += pos.shares * p;
      }
      const targetPerStock = pv / Math.max(totalSlots, 1);

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
        positions.push({
          instrumentId: c.instrumentId,
          name: nameMap.get(c.instrumentId) || "",
          entryDate: day,
          entryPrice: price,
          shares,
          pool: c.pool,
        });
        cash -= shares * price;
      }
    }

    // Daily value
    let dv = cash;
    for (const pos of positions) {
      const p = getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
      dv += pos.shares * p;
    }
    dailyValues.push({ date: day, value: dv });
  }

  // Close remaining
  const lastDate = tradingDates[tradingDates.length - 1];
  for (const pos of positions) {
    const price = getPriceOnDate(pos.instrumentId, lastDate);
    if (!price) continue;
    const holdDays = Math.round(
      (new Date(lastDate).getTime() - new Date(pos.entryDate).getTime()) /
        86400000,
    );
    closedTrades.push({
      instrumentId: pos.instrumentId,
      name: pos.name,
      pool: pos.pool,
      entryDate: pos.entryDate,
      exitDate: lastDate,
      holdDays,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      shares: pos.shares,
      pnl: (price - pos.entryPrice) * pos.shares,
      returnPct: (price / pos.entryPrice - 1) * 100,
    });
    cash += price * pos.shares;
  }

  // ─── Results ───────────────────────────────────────────────────────────
  const finalValue = cash;
  const totalReturn = (finalValue / totalContributed - 1) * 100;
  const benchFinal =
    benchmarkShares * (getPriceOnDate(BENCHMARK_ID, lastDate) || 0);
  const benchReturn = (benchFinal / totalContributed - 1) * 100;
  const alpha = totalReturn - benchReturn;

  let peak = 0,
    maxDrawdown = 0;
  for (const { value } of dailyValues) {
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const largeTrades = closedTrades.filter((t) => t.pool === "large");
  const smallTrades = closedTrades.filter((t) => t.pool === "small");
  const winners = closedTrades.filter((t) => t.pnl > 0);
  const losers = closedTrades.filter((t) => t.pnl <= 0);
  const grossWins = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const fmtSEK = (n: number) => `${Math.round(n).toLocaleString("sv-SE")} SEK`;

  log("");
  log("═".repeat(80));
  log("VINDROS UNIFIED — Single Pool (15 slots, head-to-head)");
  log("═".repeat(80));
  log("");
  log("RULES:");
  log(
    `  • Large/Mid Cap: ${largeMidInstruments.length} stocks (always eligible)`,
  );
  log(
    `  • Small/FN/Spotlight: ${smallInstruments.length} → ${qualifiedSmallCaps.size} qualified (must pass quality gate)`,
  );
  log(
    `  • All eligible stocks compete for ${TOTAL_POSITIONS} slots, ranked by 90d slope`,
  );
  log(
    `  • Monthly rebalance, equal weight across all ${TOTAL_POSITIONS} slots`,
  );
  log(`  • Contribution: ${MONTHLY_CONTRIBUTION.toLocaleString()}/month`);
  log(
    `  • Liquidity: Small caps filtered if position > ${(MAX_ADV_FRACTION * 100).toFixed(0)}% of 20-day ADV`,
  );
  log(`  • Candidates filtered for liquidity: ${liquidityFiltered} times`);
  log("");
  log("PERFORMANCE:");
  log(`  Total contributed: ${fmtSEK(totalContributed)}`);
  log(`  Final value:       ${fmtSEK(finalValue)}`);
  log(`  Return:            ${fmtPct(totalReturn)}`);
  log(`  Benchmark:         ${fmtPct(benchReturn)}`);
  log(`  ALPHA:             ${fmtPct(alpha)}`);
  log("");
  log("DRAWDOWN:");
  log(`  Max drawdown:      ${(maxDrawdown * 100).toFixed(1)}%`);
  log("");
  log("POOL BREAKDOWN:");
  log(
    `  Large/Mid trades:  ${largeTrades.length} (win rate ${((largeTrades.filter((t) => t.pnl > 0).length / largeTrades.length) * 100).toFixed(1)}%)`,
  );
  log(
    `  Small trades:      ${smallTrades.length} (win rate ${((smallTrades.filter((t) => t.pnl > 0).length / smallTrades.length) * 100).toFixed(1)}%)`,
  );
  log(
    `  Large/Mid avg ret: ${fmtPct(largeTrades.reduce((s, t) => s + t.returnPct, 0) / largeTrades.length)}`,
  );
  log(
    `  Small avg ret:     ${fmtPct(smallTrades.reduce((s, t) => s + t.returnPct, 0) / smallTrades.length)}`,
  );
  log("");
  log("TRADE STATISTICS:");
  log(`  Total trades:      ${closedTrades.length}`);
  log(
    `  Winners:           ${winners.length} (${((winners.length / closedTrades.length) * 100).toFixed(1)}%)`,
  );
  log(`  Profit factor:     ${profitFactor.toFixed(2)}`);
  log(
    `  Avg win:           ${fmtPct(winners.length ? winners.reduce((s, t) => s + t.returnPct, 0) / winners.length : 0)}`,
  );
  log(
    `  Avg loss:          ${fmtPct(losers.length ? losers.reduce((s, t) => s + t.returnPct, 0) / losers.length : 0)}`,
  );

  // ─── NEXT REBALANCE ACTION ─────────────────────────────────────────────
  // Show what the system wants to hold RIGHT NOW (last date = today)
  const today = tradingDates[tradingDates.length - 1];
  const latestTop = getUnifiedTop(
    today,
    TOTAL_POSITIONS,
    finalValue / TOTAL_POSITIONS,
    qualifiedSmallCaps,
  );

  log("");
  log("═".repeat(80));
  log(`ACTION — Rebalance on ${today}`);
  log("═".repeat(80));
  log("");
  log(`TOP ${TOTAL_POSITIONS} (unified ranking by slope, R²≥0.6 gate):`);
  for (let i = 0; i < latestTop.length; i++) {
    const c = latestTop[i];
    const price = getPriceOnDate(c.instrumentId, today);
    const tag = c.pool === "small" ? " [S]" : "";
    log(
      `  ${String(i + 1).padStart(2)}. ${(nameMap.get(c.instrumentId) || "").padEnd(25)} slope: ${c.slope.toFixed(2).padStart(6)}  R²: ${c.r2.toFixed(2)}  price: ${price?.toFixed(1)}${tag}`,
    );
  }
  log("");
  const smallInTop = latestTop.filter((c) => c.pool === "small").length;
  const largeInTop = latestTop.filter((c) => c.pool === "large").length;
  log(`  Composition: ${largeInTop} Large/Mid + ${smallInTop} Small`);
  log("");
  log(
    `QUALIFIED SMALL CAPS (${qualifiedSmallCaps.size} total passing filter):`,
  );
  const qualifiedSmallArr = [...qualifiedSmallCaps];
  const allQualifiedWithSlope = qualifiedSmallArr
    .map((id) => ({
      id,
      name: nameMap.get(id) || "",
      reg: getRegressionScore(id, today),
    }))
    .filter((x) => x.reg)
    .sort((a, b) => b.reg!.slope - a.reg!.slope);
  for (const q of allQualifiedWithSlope) {
    const inTop = latestTop.some((c) => c.instrumentId === q.id);
    log(
      `  ${inTop ? "→" : " "} ${q.name.padEnd(25)} slope: ${q.reg!.slope.toFixed(2)}`,
    );
  }

  // ─── SURVIVORSHIP / DELISTED ANALYSIS ────────────────────────────────────
  log("");
  log("═".repeat(80));
  log("SURVIVORSHIP BIAS ANALYSIS — Delisted / Dead Companies");
  log("═".repeat(80));
  log("");

  // Identify delisted instruments: last price date is significantly before END_DATE
  const DELIST_CUTOFF = new Date(END_DATE);
  DELIST_CUTOFF.setMonth(DELIST_CUTOFF.getMonth() - 3); // 3 months before end = "delisted"

  const delistedInstruments = new Map<
    number,
    { name: string; lastPriceDate: string; lastPrice: number }
  >();
  for (const [instId, prices] of pricesByInstrument) {
    if (instId === BENCHMARK_ID) continue;
    if (prices.length === 0) continue;
    const lastPrice = prices[prices.length - 1];
    if (lastPrice.date < DELIST_CUTOFF) {
      delistedInstruments.set(instId, {
        name: nameMap.get(instId) || `ID:${instId}`,
        lastPriceDate: lastPrice.date.toISOString().slice(0, 10),
        lastPrice: lastPrice.close,
      });
    }
  }

  // Find trades involving delisted companies
  const delistedTrades = closedTrades.filter((t) =>
    delistedInstruments.has(t.instrumentId),
  );

  if (delistedTrades.length === 0) {
    log("No trades involved companies that were later delisted.");
    log("(Strategy universe may not have intersected with delisted stocks)");
  } else {
    const delistedPnL = delistedTrades.reduce((s, t) => s + t.pnl, 0);
    const delistedWinners = delistedTrades.filter((t) => t.pnl > 0);
    const delistedLosers = delistedTrades.filter((t) => t.pnl <= 0);

    log(`Delisted companies in backtest universe: ${delistedInstruments.size}`);
    log(`Trades involving delisted companies: ${delistedTrades.length}`);
    log(
      `  Winners: ${delistedWinners.length}  |  Losers: ${delistedLosers.length}`,
    );
    log(
      `  Win rate: ${((delistedWinners.length / delistedTrades.length) * 100).toFixed(1)}%`,
    );
    log(`  Aggregate P&L: ${fmtSEK(delistedPnL)}`);
    log(
      `  Avg return: ${fmtPct(delistedTrades.reduce((s, t) => s + t.returnPct, 0) / delistedTrades.length)}`,
    );
    log("");

    // Sort by return (worst first) to see the damage
    const sorted = [...delistedTrades].sort(
      (a, b) => a.returnPct - b.returnPct,
    );

    log("TRADES IN DELISTED COMPANIES (sorted by return):");
    log("─".repeat(80));
    log(
      `${"Name".padEnd(28)} ${"Pool".padEnd(6)} ${"Entry".padEnd(12)} ${"Exit".padEnd(12)} ${"Hold".padStart(5)} ${"Return".padStart(9)} ${"P&L".padStart(10)} ${"Last Trade".padEnd(12)} Status`,
    );
    log("─".repeat(80));

    for (const t of sorted) {
      const info = delistedInstruments.get(t.instrumentId)!;
      const exitedBeforeDelist = t.exitDate < info.lastPriceDate;
      const status = exitedBeforeDelist
        ? "✓ exited before delist"
        : t.exitDate === info.lastPriceDate
          ? "⚠ forced exit on last day"
          : "⚠ held through final price";

      log(
        `${t.name.padEnd(28)} ${t.pool.padEnd(6)} ${t.entryDate.padEnd(12)} ${t.exitDate.padEnd(12)} ${String(t.holdDays).padStart(5)} ${fmtPct(t.returnPct).padStart(9)} ${fmtSEK(t.pnl).padStart(10)} ${info.lastPriceDate.padEnd(12)} ${status}`,
      );
    }

    log("");
    log("─".repeat(80));
    log("");

    // Summary by unique company
    const uniqueDelisted = new Map<
      number,
      { name: string; trades: typeof delistedTrades; lastDate: string }
    >();
    for (const t of delistedTrades) {
      if (!uniqueDelisted.has(t.instrumentId)) {
        uniqueDelisted.set(t.instrumentId, {
          name: t.name,
          trades: [],
          lastDate: delistedInstruments.get(t.instrumentId)!.lastPriceDate,
        });
      }
      uniqueDelisted.get(t.instrumentId)!.trades.push(t);
    }

    log("PER-COMPANY SUMMARY (delisted stocks we touched):");
    log("─".repeat(80));
    const companySummaries = [...uniqueDelisted.entries()]
      .map(([id, info]) => {
        const totalPnl = info.trades.reduce((s, t) => s + t.pnl, 0);
        const avgRet =
          info.trades.reduce((s, t) => s + t.returnPct, 0) / info.trades.length;
        return { id, ...info, totalPnl, avgRet };
      })
      .sort((a, b) => a.totalPnl - b.totalPnl);

    for (const c of companySummaries) {
      log(
        `  ${c.name.padEnd(28)} ${c.trades.length} trade(s)  avg: ${fmtPct(c.avgRet).padStart(8)}  total P&L: ${fmtSEK(c.totalPnl).padStart(10)}  stopped: ${c.lastDate}`,
      );
    }

    log("");
    log("KEY INSIGHT:");
    if (delistedPnL >= 0) {
      log(
        `  The strategy MADE money on delisted stocks (${fmtSEK(delistedPnL)}).`,
      );
      log("  Momentum got us in during the rise and out before the collapse.");
    } else {
      log(
        `  The strategy LOST ${fmtSEK(Math.abs(delistedPnL))} on delisted stocks.`,
      );
      log(
        `  This is the real cost of survivorship bias you'd miss in a clean backtest.`,
      );
      const pctOfTotal = (Math.abs(delistedPnL) / finalValue) * 100;
      log(`  Impact: ${pctOfTotal.toFixed(2)}% of final portfolio value.`);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`\nOutput: ${OUTPUT_FILE}`);
  await prisma.$disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
