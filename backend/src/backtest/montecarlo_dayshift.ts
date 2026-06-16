import "dotenv/config";
/**
 * Monte Carlo #3 — Rebalance Day Sensitivity
 *
 * Tests: "Is Vindros fragile to WHICH day of the month we rebalance?"
 *
 * Runs the full slope-ranking strategy multiple times, each time using
 * a different rebalance day offset within the month:
 * - Last trading day (default, day 0)
 * - 1st trading day
 * - ~5th trading day
 * - ~10th trading day
 * - ~15th trading day
 * - ~20th trading day
 *
 * If results are stable across all days, the strategy is robust.
 * If only month-end works, the edge might be tied to institutional flows.
 */

import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

// ─── Config ──────────────────────────────────────────────────────────────────
const START_DATE = new Date("2006-07-01");
const END_DATE = new Date("2026-05-27");
const TOTAL_POSITIONS = 15;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const BENCHMARK_ID = 638;
const REG_SHORT = 90;
const MIN_PRICE = 10;
const MIN_R2 = 0.6;
const SALARY_DAY = 23;
const LARGE_MID_MARKETS = [1, 2];

// Days to test: which trading day of the month to rebalance on
// 0 = 1st trading day, -1 = last trading day, N = Nth trading day
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

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Loading data...");

  const instruments = await prisma.instrument.findMany({
    where: { marketId: { in: LARGE_MID_MARKETS }, countryId: 1 },
    select: { id: true },
  });
  const allIds = instruments.map((i) => i.id);

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

  console.log(
    `Loaded ${allPrices.length.toLocaleString()} price rows for ${pricesByInstrument.size} instruments`,
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

  const getTop15 = (dateStr: string): number[] => {
    const candidates: { id: number; slope: number }[] = [];
    for (const id of allIds) {
      const price = getPriceOnDate(id, dateStr);
      if (!price || price < MIN_PRICE) continue;
      const reg = getRegressionScore(id, dateStr);
      if (!reg) continue;
      candidates.push({ id, slope: reg.slope });
    }
    candidates.sort((a, b) => b.slope - a.slope);
    return candidates.slice(0, TOTAL_POSITIONS).map((c) => c.id);
  };

  // ─── Run each rebalance offset ────────────────────────────────────────────
  console.log(
    `\nTesting ${REBALANCE_OFFSETS.length} different rebalance days...\n`,
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

    // Run backtest
    let cash = INITIAL_CAPITAL;
    let totalContributed = INITIAL_CAPITAL;
    let positions: { id: number; shares: number; entryPrice: number }[] = [];
    let peak = INITIAL_CAPITAL;
    let maxDD = 0;
    let tradeCount = 0;

    for (const day of tradingDates) {
      if (salaryDates.has(day)) {
        cash += MONTHLY_CONTRIBUTION;
        totalContributed += MONTHLY_CONTRIBUTION;
      }

      if (rebalanceSet.has(day)) {
        // Get current top 15
        const top15 = getTop15(day);
        const currentIds = new Set(positions.map((p) => p.id));
        const targetIds = new Set(top15);

        // Sell positions not in top 15
        const keep: typeof positions = [];
        for (const pos of positions) {
          if (targetIds.has(pos.id)) {
            keep.push(pos);
          } else {
            const price = getPriceOnDate(pos.id, day) || pos.entryPrice;
            cash += pos.shares * price;
            tradeCount++;
          }
        }
        positions = keep;

        // Equal-weight rebalance all positions
        const totalValue =
          cash +
          positions.reduce((s, p) => {
            const price = getPriceOnDate(p.id, day) || p.entryPrice;
            return s + p.shares * price;
          }, 0);
        const targetSize = totalValue / TOTAL_POSITIONS;

        // Sell all to cash for simplicity of equal-weight
        for (const pos of positions) {
          const price = getPriceOnDate(pos.id, day) || pos.entryPrice;
          cash += pos.shares * price;
        }
        positions = [];

        // Buy top 15 equally
        for (const id of top15) {
          const price = getPriceOnDate(id, day);
          if (price && price > 0) {
            const shares = targetSize / price;
            positions.push({ id, shares, entryPrice: price });
            cash -= shares * price;
            if (!currentIds.has(id)) tradeCount++;
          }
        }
      }

      // Drawdown tracking
      let portfolioValue = cash;
      for (const pos of positions) {
        const price = getPriceOnDate(pos.id, day) || pos.entryPrice;
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
      const price = getPriceOnDate(pos.id, lastDate) || pos.entryPrice;
      finalValue += pos.shares * price;
    }
    const ret = (finalValue / totalContributed - 1) * 100;

    results.push({
      label: offset.label,
      returnPct: ret,
      maxDD: maxDD * 100,
      trades: tradeCount,
    });
    process.stdout.write(
      `  ${offset.label.padEnd(22)} → +${ret.toFixed(1)}%  (DD: ${(maxDD * 100).toFixed(1)}%)\n`,
    );
  }

  // ─── Output ────────────────────────────────────────────────────────────────
  console.log("");
  console.log("═".repeat(70));
  console.log("REBALANCE DAY SENSITIVITY — Vindros (Swedish Large+Mid Cap)");
  console.log("═".repeat(70));
  console.log(
    `  Universe: ${allIds.length} stocks | 15 positions | Slope ranking`,
  );
  console.log(
    `  Period: ${tradingDates[0]} → ${tradingDates[tradingDates.length - 1]}`,
  );
  console.log("");
  console.log("  Rebalance Day           Return      Max DD     Trades");
  console.log("  " + "─".repeat(60));

  for (const r of results) {
    console.log(
      `  ${r.label.padEnd(22)}  +${r.returnPct.toFixed(1).padStart(7)}%    ${r.maxDD.toFixed(1).padStart(5)}%     ${r.trades}`,
    );
  }

  const returns = results.map((r) => r.returnPct);
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const spread = max - min;

  console.log("  " + "─".repeat(60));
  console.log(`  Mean:                   +${mean.toFixed(1)}%`);
  console.log(
    `  Range:                  +${min.toFixed(1)}% to +${max.toFixed(1)}%`,
  );
  console.log(
    `  Spread:                 ${spread.toFixed(1)} percentage points`,
  );
  console.log("");
  console.log("─".repeat(70));
  console.log("INTERPRETATION:");
  console.log("─".repeat(70));

  const coeffOfVariation = (spread / mean) * 100;
  if (coeffOfVariation < 20) {
    console.log("  ✓ Results are STABLE across rebalance days.");
    console.log(
      `  → Spread of ${spread.toFixed(0)}pp on a mean of +${mean.toFixed(0)}% = ${coeffOfVariation.toFixed(1)}% variation.`,
    );
    console.log("  → The strategy is NOT dependent on month-end effects.");
  } else if (coeffOfVariation < 40) {
    console.log("  ~ Results show MODERATE sensitivity to rebalance day.");
    console.log(
      `  → Spread of ${spread.toFixed(0)}pp on a mean of +${mean.toFixed(0)}%.`,
    );
    console.log(
      "  → Some timing dependency, but the core signal works on all days.",
    );
  } else {
    console.log("  ✗ Results are HIGHLY sensitive to rebalance day.");
    console.log(
      `  → Spread of ${spread.toFixed(0)}pp — the strategy may be fragile.`,
    );
    console.log(
      "  → Investigate if month-end institutional flows drive the edge.",
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
