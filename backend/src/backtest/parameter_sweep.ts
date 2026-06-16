import "dotenv/config";
/**
 * Parameter Sweep + Top Stock Attribution
 *
 * 1) Runs the full strategy with different regression windows (60, 90, 120, 150 days)
 *    to check if 90d is overfit or if the edge is stable across lookbacks.
 *
 * 2) On the default 90d run, tracks per-stock P&L attribution to see if
 *    a handful of stocks drove most of the returns (concentration risk).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

const OUTPUT_FILE = path.join(__dirname, "parameter_sweep_output.txt");

// ─── Config ──────────────────────────────────────────────────────────────────
const START_DATE = new Date("2006-07-01");
const END_DATE = new Date("2026-05-27");
const TOTAL_POSITIONS = 15;
const MAX_ADV_FRACTION = 0.1;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const BENCHMARK_ID = 638;
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

// Parameter sweep values
const REG_WINDOWS = [60, 90, 120, 150];

// ─── Types ───────────────────────────────────────────────────────────────────
type PriceRow = { date: Date; close: number; volume: number };
type Position = {
  instrumentId: number;
  entryPrice: number;
  shares: number;
  pool: "large" | "small";
  entryCost: number; // total capital deployed on entry
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

  log("PARAMETER SWEEP + TOP STOCK ATTRIBUTION");
  log("=".repeat(75));
  log("");
  log("Loading data...");

  const largeMidInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: LARGE_MID_MARKETS }, countryId: 1 },
    select: { id: true, name: true },
  });
  const smallInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: SMALL_MARKETS }, countryId: 1 },
    select: { id: true, name: true },
  });

  const largeMidIds = largeMidInstruments.map((i) => i.id);
  const smallIds = smallInstruments.map((i) => i.id);
  const allIds = [...largeMidIds, ...smallIds];
  const largeMidIdSet = new Set(largeMidIds);
  const nameMap = new Map<number, string>(
    [...largeMidInstruments, ...smallInstruments].map((i) => [i.id, i.name]),
  );

  await loadKpiData(smallIds);

  // Load prices with enough warmup for 150-day regression
  const warmupDate = new Date(START_DATE);
  warmupDate.setDate(warmupDate.getDate() - 220);

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

  log(
    `  Loaded ${allPrices.length.toLocaleString()} price rows for ${pricesByInstrument.size} instruments`,
  );
  log(
    `  Universe: ${largeMidIds.length} Large+Mid + ${smallIds.length} Small Cap`,
  );

  // Trading dates from benchmark
  const benchPrices = pricesByInstrument.get(BENCHMARK_ID) || [];
  const tradingDates = benchPrices
    .filter((p) => p.date >= START_DATE && p.date <= END_DATE)
    .map((p) => p.date.toISOString().slice(0, 10));

  // Month-end rebalance dates
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

  // ─── Helpers (parameterized by regWindow) ──────────────────────────────────
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

  const getRegressionScore = (
    instId: number,
    dateStr: string,
    regWindow: number,
  ) => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return undefined;
    const idx = getPriceIndex(instId, dateStr);
    if (idx < regWindow) return undefined;
    const lastPriceDate = prices[idx].date.toISOString().slice(0, 10);
    const daysDiff =
      (new Date(dateStr).getTime() - new Date(lastPriceDate).getTime()) /
      86400000;
    if (daysDiff > 7) return undefined;
    const closes = prices.map((p) => p.close);
    const slice = closes.slice(idx - regWindow + 1, idx + 1);
    const reg = linearRegression(
      slice.length >= Math.floor(regWindow * 0.67) ? slice : [],
    );
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
    regWindow: number,
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
      const reg = getRegressionScore(instId, dateStr, regWindow);
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
      const reg = getRegressionScore(instId, dateStr, regWindow);
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

  // ─── Run parameter sweep ──────────────────────────────────────────────────
  log("");
  log("PART 1: REGRESSION WINDOW SWEEP");
  log("-".repeat(75));
  log(`  Testing windows: ${REG_WINDOWS.join(", ")} days`);
  log(
    `  (Everything else fixed: last-day rebalance, R2>${MIN_R2}, 15 positions)`,
  );
  log("");

  type SweepResult = {
    window: number;
    returnPct: number;
    maxDD: number;
    trades: number;
  };
  const sweepResults: SweepResult[] = [];

  // Also track attribution for the 90-day run
  // stockPnL: instrumentId → { realized, unrealized, tradeCount, holdingMonths }
  const stockPnL = new Map<number, { realized: number; trades: number }>();

  for (const regWindow of REG_WINDOWS) {
    const isDefaultRun = regWindow === 90;

    let cash = INITIAL_CAPITAL;
    let totalContributed = INITIAL_CAPITAL;
    let positions: Position[] = [];
    let peak = INITIAL_CAPITAL;
    let maxDD = 0;
    let tradeCount = 0;
    let qualifiedSmallCaps = new Set<number>();
    let lastQualifyKey = 0;

    for (const day of tradingDates) {
      if (salaryDates.has(day)) {
        cash += MONTHLY_CONTRIBUTION;
        totalContributed += MONTHLY_CONTRIBUTION;
      }

      // Quarterly re-qualification
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

      // Monthly rebalance (last trading day)
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
          regWindow,
        );
        const targetIds = new Set(topCandidates.map((c) => c.instrumentId));

        // Sell positions not in top (hold logic)
        const keepPositions: Position[] = [];
        for (const pos of positions) {
          if (targetIds.has(pos.instrumentId)) {
            keepPositions.push(pos);
          } else {
            const price =
              getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
            const sellValue = price * pos.shares;
            const pnl = sellValue - pos.entryCost;
            cash += sellValue;
            tradeCount++;

            // Track attribution for 90d run
            if (isDefaultRun) {
              const existing = stockPnL.get(pos.instrumentId) || {
                realized: 0,
                trades: 0,
              };
              existing.realized += pnl;
              existing.trades++;
              stockPnL.set(pos.instrumentId, existing);
            }
          }
        }
        positions = keepPositions;

        // Rebalance: equal weight
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
              const trimValue = sellShares * price;
              const trimCostBasis = pos.entryCost * (sellShares / pos.shares);
              cash += trimValue;
              pos.shares -= sellShares;
              pos.entryCost -= trimCostBasis;

              if (isDefaultRun) {
                const existing = stockPnL.get(pos.instrumentId) || {
                  realized: 0,
                  trades: 0,
                };
                existing.realized += trimValue - trimCostBasis;
                stockPnL.set(pos.instrumentId, existing);
              }
            }
          }
        }

        // Top up underweight
        for (const pos of positions) {
          const price = getPriceOnDate(pos.instrumentId, day);
          if (!price) continue;
          const currentValue = pos.shares * price;
          if (currentValue < targetPerStock * 0.99) {
            const buyShares = Math.floor(
              (targetPerStock - currentValue) / price,
            );
            if (buyShares > 0 && cash >= buyShares * price) {
              const buyCost = buyShares * price;
              cash -= buyCost;
              pos.shares += buyShares;
              pos.entryCost += buyCost;
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
            shares,
            pool: c.pool,
            entryCost: cost,
          });
          cash -= cost;
          tradeCount++;
        }
      }

      // Drawdown tracking
      let portfolioValue = cash;
      for (const pos of positions) {
        const price = getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
        portfolioValue += pos.shares * price;
      }
      if (portfolioValue > peak) peak = portfolioValue;
      const dd = (peak - portfolioValue) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    // Final value + unrealized gains for attribution
    const lastDate = tradingDates[tradingDates.length - 1];
    let finalValue = cash;
    for (const pos of positions) {
      const price =
        getPriceOnDate(pos.instrumentId, lastDate) || pos.entryPrice;
      finalValue += pos.shares * price;

      if (isDefaultRun) {
        const unrealized = pos.shares * price - pos.entryCost;
        const existing = stockPnL.get(pos.instrumentId) || {
          realized: 0,
          trades: 0,
        };
        existing.realized += unrealized;
        stockPnL.set(pos.instrumentId, existing);
      }
    }

    const ret = (finalValue / totalContributed - 1) * 100;
    sweepResults.push({
      window: regWindow,
      returnPct: ret,
      maxDD: maxDD * 100,
      trades: tradeCount,
    });

    const marker = regWindow === 90 ? " ← current" : "";
    log(
      `  ${regWindow}d window → +${ret.toFixed(1)}%  (DD: ${(maxDD * 100).toFixed(1)}%, Trades: ${tradeCount})${marker}`,
    );
  }

  // ─── Benchmark ─────────────────────────────────────────────────────────────
  let bmShares =
    INITIAL_CAPITAL / (getPriceOnDate(BENCHMARK_ID, tradingDates[0]) || 1);
  let bmContributed = INITIAL_CAPITAL;
  for (const [ym, days] of monthsInRange) {
    const cutoff = `${ym}-${String(SALARY_DAY).padStart(2, "0")}`;
    let salaryDate = days[0];
    for (const d of days) {
      if (d <= cutoff) salaryDate = d;
    }
    const bmPrice = getPriceOnDate(BENCHMARK_ID, salaryDate);
    if (bmPrice) {
      bmShares += MONTHLY_CONTRIBUTION / bmPrice;
      bmContributed += MONTHLY_CONTRIBUTION;
    }
  }
  const bmFinal =
    bmShares *
    (getPriceOnDate(BENCHMARK_ID, tradingDates[tradingDates.length - 1]) || 0);
  const bmReturn = (bmFinal / bmContributed - 1) * 100;

  // ─── Sweep output ──────────────────────────────────────────────────────────
  log("");
  log("  Regression Window     Return      Max DD     Trades");
  log("  " + "-".repeat(55));
  for (const r of sweepResults) {
    const marker = r.window === 90 ? " *" : "  ";
    log(
      `${marker} ${String(r.window).padStart(3)}d             +${r.returnPct.toFixed(1).padStart(7)}%    ${r.maxDD.toFixed(1).padStart(5)}%     ${r.trades}`,
    );
  }
  const returns = sweepResults.map((r) => r.returnPct);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const spread = Math.max(...returns) - Math.min(...returns);
  const coeff = (spread / mean) * 100;
  log("  " + "-".repeat(55));
  log(`  Benchmark (OMXSPI):   +${bmReturn.toFixed(1)}%`);
  log(`  Mean across windows:  +${mean.toFixed(1)}%`);
  log(
    `  Spread:               ${spread.toFixed(1)}pp (${coeff.toFixed(1)}% of mean)`,
  );
  log("");

  if (coeff < 25) {
    log("  VERDICT: ROBUST — returns are stable across lookback windows.");
    log("  → 90d is NOT overfit. The edge exists at multiple timescales.");
  } else if (coeff < 50) {
    log("  VERDICT: MODERATE — some sensitivity to lookback window.");
    log("  → 90d works, but the edge is somewhat tuned to this timeframe.");
  } else {
    log("  VERDICT: SENSITIVE — large variation across windows.");
    log("  → Possible overfitting to 90d. Consider a blend or longer window.");
  }

  // ─── Part 2: Attribution ───────────────────────────────────────────────────
  log("");
  log("");
  log("PART 2: TOP STOCK ATTRIBUTION (90d window run)");
  log("-".repeat(75));

  // Sort by total P&L
  const sorted = [...stockPnL.entries()]
    .map(([id, data]) => ({ id, name: nameMap.get(id) || `ID:${id}`, ...data }))
    .sort((a, b) => b.realized - a.realized);

  const totalPnL = sorted.reduce((s, x) => s + x.realized, 0);
  const positiveStocks = sorted.filter((s) => s.realized > 0);
  const negativeStocks = sorted.filter((s) => s.realized < 0);

  log(`  Total stocks traded: ${sorted.length}`);
  log(
    `  Profitable: ${positiveStocks.length} | Losing: ${negativeStocks.length}`,
  );
  log(`  Total P&L: ${Math.round(totalPnL).toLocaleString("sv-SE")} SEK`);
  log("");

  // Top 10 winners
  log("  TOP 10 WINNERS:");
  log("  " + "-".repeat(65));
  log("  #   Stock                      P&L (SEK)     % of total   Trades");
  log("  " + "-".repeat(65));
  let cumulativePct = 0;
  for (let i = 0; i < Math.min(10, sorted.length); i++) {
    const s = sorted[i];
    const pct = (s.realized / totalPnL) * 100;
    cumulativePct += pct;
    log(
      `  ${String(i + 1).padStart(2)}  ${s.name.padEnd(25)}  ${Math.round(s.realized).toLocaleString("sv-SE").padStart(12)} SEK    ${pct.toFixed(1).padStart(5)}%      ${s.trades}`,
    );
  }
  log("  " + "-".repeat(65));
  log(`  Top 10 cumulative: ${cumulativePct.toFixed(1)}% of total P&L`);

  // Top 5 concentration
  const top5Pct =
    (sorted.slice(0, 5).reduce((s, x) => s + x.realized, 0) / totalPnL) * 100;
  const top10Pct = cumulativePct;
  const top20Pct =
    (sorted.slice(0, 20).reduce((s, x) => s + x.realized, 0) / totalPnL) * 100;

  log("");
  log("  CONCENTRATION:");
  log(`    Top 5 stocks:  ${top5Pct.toFixed(1)}% of total P&L`);
  log(`    Top 10 stocks: ${top10Pct.toFixed(1)}% of total P&L`);
  log(`    Top 20 stocks: ${top20Pct.toFixed(1)}% of total P&L`);
  log("");

  // Bottom 5 (worst losers)
  log("  TOP 5 LOSERS:");
  log("  " + "-".repeat(65));
  const losers = sorted.slice(-5).reverse();
  for (const s of losers) {
    const pct = (s.realized / totalPnL) * 100;
    log(
      `      ${s.name.padEnd(25)}  ${Math.round(s.realized).toLocaleString("sv-SE").padStart(12)} SEK    ${pct.toFixed(1).padStart(5)}%      ${s.trades}`,
    );
  }

  // Interpretation
  log("");
  log("-".repeat(75));
  log("INTERPRETATION:");
  log("-".repeat(75));
  if (top5Pct > 50) {
    log(
      `  Top 5 stocks drove ${top5Pct.toFixed(0)}% of returns — HIGH concentration.`,
    );
    log("  → Check if they are from one sector/era. If so, it's a sector bet.");
    log(
      "  → If they span sectors and decades, momentum is working as intended.",
    );
  } else if (top5Pct > 30) {
    log(
      `  Top 5 stocks drove ${top5Pct.toFixed(0)}% of returns — MODERATE concentration.`,
    );
    log(
      "  → Strategy captures momentum broadly, not dependent on a few stocks.",
    );
  } else {
    log(
      `  Top 5 stocks drove only ${top5Pct.toFixed(0)}% of returns — WELL DIVERSIFIED.`,
    );
    log("  → Returns come from many stocks. No single-stock dependency.");
  }
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
