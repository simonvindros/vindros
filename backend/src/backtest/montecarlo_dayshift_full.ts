import "dotenv/config";
/**
 * Monte Carlo #3b — Rebalance Day Sensitivity (FULL STRATEGY)
 *
 * Same test as montecarlo_dayshift.ts but with the COMPLETE strategy:
 * - Large+Mid Cap: pure slope ranking
 * - Small Cap: quality gate (revenue growth, revenue, op margin, quarterly freshness)
 * - "Hold if still top 15" logic (reduces turnover)
 * - ADV-based liquidity filtering for small caps
 * - Proper rebalance: trim overweight, top up underweight, buy new entries
 * - Quarterly re-qualification of small caps
 *
 * Tests 6 different rebalance days within the month.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

const OUTPUT_FILE = path.join(__dirname, "dayshift_full_output.txt");

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

// Days to test
const REBALANCE_OFFSETS = [
  { label: "1st trading day", index: 0 },
  { label: "~5th trading day", index: 4 },
  { label: "~10th trading day", index: 9 },
  { label: "~15th trading day", index: 14 },
  { label: "~20th trading day", index: 19 },
  { label: "Last trading day", index: -1 },
];

// ─── Types ───────────────────────────────────────────────────────────────────
type PriceRow = { date: Date; close: number; volume: number };
type Position = {
  instrumentId: number;
  entryPrice: number;
  shares: number;
  pool: "large" | "small";
};

// ─── KPI data stores ─────────────────────────────────────────────────────────
type KpiData = Map<number, Map<number, Map<number, number>>>; // instId → kpiId → year → value
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

  // Quarterly freshness check
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

  log("Monte Carlo #3b — Rebalance Day Sensitivity (FULL STRATEGY)");
  log("Loading data...");

  const largeMidInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: LARGE_MID_MARKETS }, countryId: 1 },
    select: { id: true },
  });
  const smallInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: SMALL_MARKETS }, countryId: 1 },
    select: { id: true },
  });

  const largeMidIds = largeMidInstruments.map((i) => i.id);
  const smallIds = smallInstruments.map((i) => i.id);
  const allIds = [...largeMidIds, ...smallIds];
  const largeMidIdSet = new Set(largeMidIds);

  log(`  Large+Mid Cap: ${largeMidIds.length} stocks`);
  log(`  Small Cap: ${smallIds.length} stocks`);

  // Load KPI data for small cap qualification
  await loadKpiData(smallIds);
  log("  KPI data loaded for small cap qualification");

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

  log(
    `  Loaded ${allPrices.length.toLocaleString()} price rows for ${pricesByInstrument.size} instruments`,
  );

  // Trading dates from benchmark
  const benchPrices = pricesByInstrument.get(BENCHMARK_ID) || [];
  const tradingDates = benchPrices
    .filter((p) => p.date >= START_DATE && p.date <= END_DATE)
    .map((p) => p.date.toISOString().slice(0, 10));

  // Group trading days by month
  const monthsMap = new Map<string, string[]>();
  for (const d of tradingDates) {
    const ym = d.slice(0, 7);
    if (!monthsMap.has(ym)) monthsMap.set(ym, []);
    monthsMap.get(ym)!.push(d);
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

  // ─── Run each rebalance offset ────────────────────────────────────────────
  log(
    `\nTesting ${REBALANCE_OFFSETS.length} different rebalance days (full strategy)...\n`,
  );

  const results: {
    label: string;
    returnPct: number;
    maxDD: number;
    trades: number;
  }[] = [];

  for (const offset of REBALANCE_OFFSETS) {
    // Build rebalance dates for this offset
    const rebalanceDates: string[] = [];
    for (const [_ym, days] of monthsMap) {
      if (offset.index === -1) {
        rebalanceDates.push(days[days.length - 1]);
      } else {
        const idx = Math.min(offset.index, days.length - 1);
        rebalanceDates.push(days[idx]);
      }
    }
    const rebalanceSet = new Set(rebalanceDates);

    // Salary dates (still on the 23rd or earlier)
    const salaryDates = new Set<string>();
    for (const [ym, days] of monthsMap) {
      const cutoff = `${ym}-${String(SALARY_DAY).padStart(2, "0")}`;
      let salaryDate = days[0];
      for (const d of days) {
        if (d <= cutoff) salaryDate = d;
      }
      salaryDates.add(salaryDate);
    }

    // Run backtest with full strategy
    let cash = INITIAL_CAPITAL;
    let totalContributed = INITIAL_CAPITAL;
    let positions: Position[] = [];
    let peak = INITIAL_CAPITAL;
    let maxDD = 0;
    let tradeCount = 0;
    let qualifiedSmallCaps = new Set<number>();
    let lastQualifyKey = 0;

    for (const day of tradingDates) {
      // Salary contribution
      if (salaryDates.has(day)) {
        cash += MONTHLY_CONTRIBUTION;
        totalContributed += MONTHLY_CONTRIBUTION;
      }

      // Quarterly re-qualification of small caps
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

      // Rebalance day
      if (rebalanceSet.has(day)) {
        // Estimate position size for liquidity filter
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

        // Sell positions not in top (hold logic: keep if still ranked)
        const keepPositions: Position[] = [];
        for (const pos of positions) {
          if (targetIds.has(pos.instrumentId)) {
            keepPositions.push(pos);
          } else {
            const price =
              getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
            cash += price * pos.shares;
            tradeCount++;
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
            const buyShares = Math.floor(
              (targetPerStock - currentValue) / price,
            );
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
            entryPrice: price,
            shares,
            pool: c.pool,
          });
          cash -= shares * price;
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

    // Final value
    const lastDate = tradingDates[tradingDates.length - 1];
    let finalValue = cash;
    for (const pos of positions) {
      const price =
        getPriceOnDate(pos.instrumentId, lastDate) || pos.entryPrice;
      finalValue += pos.shares * price;
    }
    const ret = (finalValue / totalContributed - 1) * 100;

    results.push({
      label: offset.label,
      returnPct: ret,
      maxDD: maxDD * 100,
      trades: tradeCount,
    });
    log(
      `  ${offset.label.padEnd(22)} → +${ret.toFixed(1)}%  (DD: ${(maxDD * 100).toFixed(1)}%, Trades: ${tradeCount})`,
    );
  }

  // ─── Benchmark ─────────────────────────────────────────────────────────────
  let bmShares =
    INITIAL_CAPITAL / (getPriceOnDate(BENCHMARK_ID, tradingDates[0]) || 1);
  let bmContributed = INITIAL_CAPITAL;
  for (const [_ym, days] of monthsMap) {
    const cutoff = `${_ym}-${String(SALARY_DAY).padStart(2, "0")}`;
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

  // ─── Output ────────────────────────────────────────────────────────────────
  log("");
  log("=".repeat(75));
  log(
    "REBALANCE DAY SENSITIVITY — FULL STRATEGY (Large+Mid + Small Cap Quality Gate)",
  );
  log("=".repeat(75));
  log(
    `  Universe: ${largeMidIds.length} Large+Mid + ${smallIds.length} Small Cap (quality-gated)`,
  );
  log(
    `  Period: ${tradingDates[0]} → ${tradingDates[tradingDates.length - 1]}`,
  );
  log(`  Benchmark (OMXSPI): +${bmReturn.toFixed(1)}%`);
  log("");
  log("  Rebalance Day           Return      Max DD     Trades");
  log("  " + "-".repeat(60));

  for (const r of results) {
    log(
      `  ${r.label.padEnd(22)}  +${r.returnPct.toFixed(1).padStart(7)}%    ${r.maxDD.toFixed(1).padStart(5)}%     ${r.trades}`,
    );
  }

  const returns = results.map((r) => r.returnPct);
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const spread = max - min;

  log("  " + "-".repeat(60));
  log(`  Mean:                   +${mean.toFixed(1)}%`);
  log(`  Range:                  +${min.toFixed(1)}% to +${max.toFixed(1)}%`);
  log(`  Spread:                 ${spread.toFixed(1)} percentage points`);
  log(
    `  All beat benchmark:     ${results.every((r) => r.returnPct > bmReturn) ? "YES" : "NO"}`,
  );
  log("");

  // Compare with simplified test
  log("-".repeat(75));
  log(
    "COMPARISON: Full strategy vs simplified (Large+Mid only) from previous run:",
  );
  log("-".repeat(75));
  log("  Simplified (Large+Mid only):  Range +387% to +931%  (spread: 544pp)");
  log(
    `  Full strategy:                Range +${min.toFixed(0)}% to +${max.toFixed(0)}%  (spread: ${spread.toFixed(0)}pp)`,
  );
  log("");

  log("-".repeat(75));
  log("INTERPRETATION:");
  log("-".repeat(75));

  const coeffOfVariation = (spread / mean) * 100;
  if (coeffOfVariation < 20) {
    log("  STABLE across rebalance days.");
    log(
      `  → Spread of ${spread.toFixed(0)}pp on a mean of +${mean.toFixed(0)}% = ${coeffOfVariation.toFixed(1)}% variation.`,
    );
    log("  → The full strategy is NOT dependent on month-end effects.");
    log("  → Quality gate may be dampening day-sensitivity.");
  } else if (coeffOfVariation < 40) {
    log("  MODERATE sensitivity to rebalance day.");
    log(
      `  → Spread of ${spread.toFixed(0)}pp on a mean of +${mean.toFixed(0)}%.`,
    );
    log("  → Some timing dependency, but the core signal works on all days.");
  } else {
    log("  HIGHLY sensitive to rebalance day.");
    log(
      `  → Spread of ${spread.toFixed(0)}pp — comparable to simplified version.`,
    );
    log("  → Quality gate does NOT reduce timing sensitivity.");
    log("  → Month-end institutional flows likely drive part of the edge.");
  }

  log("");
  log("Done.");

  // Write to file
  fs.writeFileSync(OUTPUT_FILE, output.join("\n"), "utf-8");
  console.log(`\nResults written to: ${OUTPUT_FILE}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
