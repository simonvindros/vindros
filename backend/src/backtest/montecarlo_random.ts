import "dotenv/config";
/**
 * Monte Carlo #2 — Random Stock Selection
 *
 * The killer test: instead of picking top 15 by slope ranking,
 * pick 15 RANDOM stocks from the same Swedish Large+Mid Cap universe
 * each month. Run 1,000 times.
 *
 * If random selection also beats the index massively, the edge is
 * the universe + equal-weight rebalancing, NOT the slope ranking.
 * If random selection underperforms, the slope ranking is genuinely valuable.
 */

import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

// ─── Config ──────────────────────────────────────────────────────────────────
const SIMULATIONS = 1_000;
const START_DATE = new Date("2006-07-01");
const END_DATE = new Date("2026-05-27");
const TOTAL_POSITIONS = 15;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const BENCHMARK_ID = 638;
const MIN_PRICE = 10;
const SALARY_DAY = 23;
const LARGE_MID_MARKETS = [1, 2];

// ─── Types ───────────────────────────────────────────────────────────────────
type PriceRow = { date: Date; close: number; volume: number };

// ─── Helpers ─────────────────────────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Loading data...");

  // Load Large+Mid Cap Swedish instruments
  const instruments = await prisma.instrument.findMany({
    where: { marketId: { in: LARGE_MID_MARKETS }, countryId: 1 },
    select: { id: true },
  });
  const allIds = instruments.map((i) => i.id);

  console.log(`Universe: ${allIds.length} Large+Mid Cap Swedish stocks`);

  // Load all prices
  const warmupDate = new Date(START_DATE);
  warmupDate.setDate(warmupDate.getDate() - 10);

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

  console.log(`Loaded ${allPrices.length.toLocaleString()} price rows`);

  // Build trading dates from benchmark
  const benchPrices = pricesByInstrument.get(BENCHMARK_ID) || [];
  const tradingDates = benchPrices
    .filter((p) => p.date >= START_DATE && p.date <= END_DATE)
    .map((p) => p.date.toISOString().slice(0, 10));

  // Rebalance = last trading day of month
  const monthEnds: string[] = [];
  for (let i = 0; i < tradingDates.length - 1; i++) {
    if (tradingDates[i].slice(0, 7) !== tradingDates[i + 1].slice(0, 7))
      monthEnds.push(tradingDates[i]);
  }
  if (tradingDates.length > 0)
    monthEnds.push(tradingDates[tradingDates.length - 1]);

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

  // ─── Price lookup ────────────────────────────────────────────────────────
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

  // Get eligible stocks on a given date (have a price > MIN_PRICE, traded recently)
  const getEligible = (dateStr: string): number[] => {
    const eligible: number[] = [];
    const targetTime = new Date(dateStr).getTime();
    for (const id of allIds) {
      const prices = pricesByInstrument.get(id);
      if (!prices || prices.length < 30) continue;
      // Find latest price on or before date
      let lo = 0,
        hi = prices.length - 1,
        bestIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (prices[mid].date.toISOString().slice(0, 10) <= dateStr) {
          bestIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (bestIdx < 0) continue;
      const price = prices[bestIdx].close;
      if (price < MIN_PRICE) continue;
      // Stale check: last price within 7 days
      const daysDiff = (targetTime - prices[bestIdx].date.getTime()) / 86400000;
      if (daysDiff > 7) continue;
      eligible.push(id);
    }
    return eligible;
  };

  // ─── Compute benchmark return ────────────────────────────────────────────
  let bmShares =
    INITIAL_CAPITAL / (getPriceOnDate(BENCHMARK_ID, tradingDates[0]) || 1);
  let bmContributed = INITIAL_CAPITAL;
  for (const day of tradingDates) {
    if (salaryDates.has(day)) {
      const bmPrice = getPriceOnDate(BENCHMARK_ID, day);
      if (bmPrice) {
        bmShares += MONTHLY_CONTRIBUTION / bmPrice;
        bmContributed += MONTHLY_CONTRIBUTION;
      }
    }
  }
  const lastDate = tradingDates[tradingDates.length - 1];
  const bmFinal = bmShares * (getPriceOnDate(BENCHMARK_ID, lastDate) || 0);
  const bmReturn = (bmFinal / bmContributed - 1) * 100;

  // ─── Pre-compute eligible stocks per rebalance date ──────────────────────
  console.log("Pre-computing eligible stocks per month...");
  const eligiblePerMonth = new Map<string, number[]>();
  for (const monthEnd of monthEnds) {
    eligiblePerMonth.set(monthEnd, getEligible(monthEnd));
  }

  // ─── Run Simulations ─────────────────────────────────────────────────────
  console.log(
    `\nRunning ${SIMULATIONS} simulations with RANDOM stock selection...\n`,
  );

  const simReturns: number[] = [];
  const simDrawdowns: number[] = [];

  for (let sim = 0; sim < SIMULATIONS; sim++) {
    let cash = INITIAL_CAPITAL;
    let totalContributed = INITIAL_CAPITAL;
    let positions: { id: number; shares: number; entryPrice: number }[] = [];
    let peak = INITIAL_CAPITAL;
    let maxDD = 0;

    for (const day of tradingDates) {
      // Salary
      if (salaryDates.has(day)) {
        cash += MONTHLY_CONTRIBUTION;
        totalContributed += MONTHLY_CONTRIBUTION;
      }

      // Rebalance on month-end
      if (monthEnds.includes(day)) {
        // Sell all current positions
        for (const pos of positions) {
          const price = getPriceOnDate(pos.id, day) || pos.entryPrice;
          cash += pos.shares * price;
        }
        positions = [];

        // Pick 15 random eligible stocks
        const eligible = eligiblePerMonth.get(day) || [];
        if (eligible.length >= TOTAL_POSITIONS) {
          const picks = pickRandom(eligible, TOTAL_POSITIONS);
          const positionSize = cash / TOTAL_POSITIONS;

          for (const id of picks) {
            const price = getPriceOnDate(id, day);
            if (price && price > 0) {
              const shares = positionSize / price;
              positions.push({ id, shares, entryPrice: price });
              cash -= shares * price;
            }
          }
        }
      }

      // Track portfolio value for drawdown
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
    let finalValue = cash;
    for (const pos of positions) {
      const price = getPriceOnDate(pos.id, lastDate) || pos.entryPrice;
      finalValue += pos.shares * price;
    }

    const ret = (finalValue / totalContributed - 1) * 100;
    simReturns.push(ret);
    simDrawdowns.push(maxDD * 100);

    if (sim % 100 === 0)
      process.stdout.write(`\r  Simulation ${sim}/${SIMULATIONS}`);
  }
  process.stdout.write(`\r  Done!                          \n`);

  // ─── Results ──────────────────────────────────────────────────────────────
  simReturns.sort((a, b) => a - b);
  simDrawdowns.sort((a, b) => a - b);

  const meanReturn = simReturns.reduce((s, r) => s + r, 0) / simReturns.length;
  const meanDD = simDrawdowns.reduce((s, d) => s + d, 0) / simDrawdowns.length;

  console.log("");
  console.log("═".repeat(70));
  console.log("MONTE CARLO — RANDOM STOCK SELECTION (Swedish Large+Mid Cap)");
  console.log("═".repeat(70));
  console.log(
    `  Universe: ${allIds.length} stocks | Positions: ${TOTAL_POSITIONS} | Monthly rebalance`,
  );
  console.log(`  Simulations: ${SIMULATIONS}`);
  console.log(
    `  Period: ${tradingDates[0]} → ${lastDate} (${monthEnds.length} months)`,
  );
  console.log("");
  console.log("─".repeat(70));
  console.log("RETURN DISTRIBUTION (random 15 stocks each month):");
  console.log("─".repeat(70));
  console.log(`  Mean return:     +${meanReturn.toFixed(1)}%`);
  console.log(`  Median return:   +${percentile(simReturns, 50).toFixed(1)}%`);
  console.log(
    `  5th percentile:  +${percentile(simReturns, 5).toFixed(1)}%  (unlucky)`,
  );
  console.log(`  25th percentile: +${percentile(simReturns, 25).toFixed(1)}%`);
  console.log(`  75th percentile: +${percentile(simReturns, 75).toFixed(1)}%`);
  console.log(
    `  95th percentile: +${percentile(simReturns, 95).toFixed(1)}%  (lucky)`,
  );
  console.log("");
  console.log("─".repeat(70));
  console.log("COMPARISONS:");
  console.log("─".repeat(70));
  console.log(`  VINDROS (slope ranking):  +1618.8%`);
  console.log(`  Random selection mean:    +${meanReturn.toFixed(1)}%`);
  console.log(`  Benchmark (OMXSPI DCA):   +${bmReturn.toFixed(1)}%`);
  console.log(
    `  Slope ranking edge:       +${(1618.8 - meanReturn).toFixed(1)}% over random`,
  );
  console.log(
    `  Random vs index:          +${(meanReturn - bmReturn).toFixed(1)}% over benchmark`,
  );
  console.log("");
  console.log("─".repeat(70));
  console.log("MAX DRAWDOWN DISTRIBUTION:");
  console.log("─".repeat(70));
  console.log(`  Mean max DD:     ${meanDD.toFixed(1)}%`);
  console.log(`  Median max DD:   ${percentile(simDrawdowns, 50).toFixed(1)}%`);
  console.log(
    `  95th percentile: ${percentile(simDrawdowns, 95).toFixed(1)}%  (worst 5%)`,
  );
  console.log("");
  console.log("─".repeat(70));
  console.log("INTERPRETATION:");
  console.log("─".repeat(70));

  if (1618.8 > percentile(simReturns, 95)) {
    console.log(
      "  ✓ Vindros (+1618.8%) EXCEEDS the 95th percentile of random selection.",
    );
    console.log(
      "  → The slope ranking is GENUINELY adding value beyond universe selection.",
    );
    console.log(
      `  → Ranking contributes ~+${(1618.8 - meanReturn).toFixed(0)}% over 20 years.`,
    );
  } else if (1618.8 > percentile(simReturns, 50)) {
    console.log(
      "  ~ Vindros is above median but within normal range of random selection.",
    );
    console.log(
      "  → Some of the edge is ranking, but much is just the universe.",
    );
  } else {
    console.log("  ✗ Vindros is BELOW or AT the median of random selection.");
    console.log(
      "  → The slope ranking adds nothing. The edge is purely the universe.",
    );
  }

  if (meanReturn > bmReturn * 2) {
    console.log("");
    console.log(
      "  ★ Even RANDOM stock picks from Large+Mid Cap massively beat the index.",
    );
    console.log(
      "  → Equal-weight monthly rebalancing in a quality universe is itself a strategy.",
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
