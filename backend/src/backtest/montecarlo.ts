/**
 * MONTE CARLO ANALYSIS — Is the return path-dependent?
 *
 * 1. Runs the full dynamic backtest to extract monthly returns
 * 2. Shuffles those returns 10,000 times to test sequencing luck
 * 3. Computes confidence intervals on terminal wealth
 * 4. Tests transaction cost sensitivity (at what cost does alpha disappear?)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadEngineData,
  getPriceOnDate,
  getAllCandidates,
  allocatePositions,
  getQualifiedSmallCaps,
  latestAvailableQuarter,
  disconnect,
  INITIAL_CAPITAL,
  MONTHLY_CONTRIBUTION,
  BENCHMARK_ID,
  Position,
} from "./engine";

const OUTPUT_FILE = path.join(__dirname, "montecarlo_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

const SIMULATIONS = 10_000;

// ─── Seeded PRNG (reproducible results) ──────────────────────────────────────
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates shuffle with custom RNG
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const run = async () => {
  log("Loading data...");
  const data = await loadEngineData();
  log(`Loaded. Running backtest to extract monthly returns...`);

  // ─── Run backtest to collect monthly returns ───────────────────────────
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let totalContributed = INITIAL_CAPITAL;
  let benchmarkShares =
    INITIAL_CAPITAL /
    (getPriceOnDate(
      data.pricesByInstrument,
      BENCHMARK_ID,
      data.tradingDates[0],
    ) || 1);

  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyYear = 0;
  let monthCount = 0;
  let prevMonthPV = INITIAL_CAPITAL;

  // Monthly data
  const monthlyReturns: number[] = []; // pure return (excluding contributions)
  const monthlyContributions: number[] = []; // SEK added that month
  const monthlyPVs: number[] = [INITIAL_CAPITAL];
  const monthlyBMs: number[] = [INITIAL_CAPITAL];
  let tradesThisMonth = 0;
  const monthlyTrades: number[] = [];
  let contributionThisMonth = 0;

  for (const day of data.tradingDates) {
    if (data.salaryDates.has(day)) {
      cash += MONTHLY_CONTRIBUTION;
      totalContributed += MONTHLY_CONTRIBUTION;
      contributionThisMonth += MONTHLY_CONTRIBUTION;
      const bmPrice = getPriceOnDate(
        data.pricesByInstrument,
        BENCHMARK_ID,
        day,
      );
      if (bmPrice) benchmarkShares += MONTHLY_CONTRIBUTION / bmPrice;
    }

    const currentYear = parseInt(day.slice(0, 4));
    const currentMonth = parseInt(day.slice(5, 7));
    const currentQ = Math.ceil(currentMonth / 3);
    const qualifyKey = currentYear * 10 + currentQ;
    if (qualifyKey > lastQualifyYear) {
      const avail = latestAvailableQuarter(day);
      qualifiedSmallCaps = getQualifiedSmallCaps(
        data.kpiData,
        data.qKpiData,
        data.smallIds,
        currentYear - 1,
        avail.year,
        avail.period,
      );
      lastQualifyYear = qualifyKey;
    }

    if (data.monthEndSet.has(day)) {
      monthCount++;
      tradesThisMonth = 0;

      let currentPV = cash;
      for (const pos of positions) {
        const p =
          getPriceOnDate(data.pricesByInstrument, pos.tradeId, day) ||
          pos.entryPrice;
        currentPV += pos.shares * p;
      }

      // Compute pure return (excluding new money)
      const prePV = prevMonthPV + contributionThisMonth;
      const monthReturn = prePV > 0 ? (currentPV - prePV) / prePV : 0;
      monthlyReturns.push(monthReturn);
      monthlyContributions.push(contributionThisMonth);
      monthlyPVs.push(currentPV);

      const bmValue =
        benchmarkShares *
        (getPriceOnDate(data.pricesByInstrument, BENCHMARK_ID, day) || 0);
      monthlyBMs.push(bmValue);

      // Rebalance
      const allCandidates = getAllCandidates(data, day, qualifiedSmallCaps);
      const { allocations } = allocatePositions(
        data,
        allCandidates,
        currentPV,
        day,
      );
      const allSelectedSignalIds = new Set(
        allocations.map((a) => a.instrumentId),
      );

      const keepPositions: Position[] = [];
      for (const pos of positions) {
        if (allSelectedSignalIds.has(pos.instrumentId)) {
          keepPositions.push(pos);
        } else {
          const price = getPriceOnDate(
            data.pricesByInstrument,
            pos.tradeId,
            day,
          );
          if (price) {
            cash += price * pos.shares;
            tradesThisMonth++;
          }
        }
      }
      positions = keepPositions;

      const allocationMap = new Map(
        allocations.map((a) => [a.instrumentId, a]),
      );
      for (const pos of positions) {
        const alloc = allocationMap.get(pos.instrumentId);
        if (!alloc) continue;
        const price = getPriceOnDate(data.pricesByInstrument, pos.tradeId, day);
        if (!price) continue;
        const currentValue = pos.shares * price;
        const target = alloc.allocation;
        if (currentValue > target * 1.01) {
          const sellShares = Math.floor((currentValue - target) / price);
          if (sellShares > 0) {
            cash += sellShares * price;
            pos.shares -= sellShares;
            tradesThisMonth++;
          }
        } else if (currentValue < target * 0.99) {
          const buyShares = Math.floor((target - currentValue) / price);
          if (buyShares > 0 && cash >= buyShares * price) {
            cash -= buyShares * price;
            pos.shares += buyShares;
            tradesThisMonth++;
          }
        }
      }

      const heldSignalIds = new Set(positions.map((p) => p.instrumentId));
      for (const a of allocations) {
        if (heldSignalIds.has(a.instrumentId)) continue;
        const price = getPriceOnDate(data.pricesByInstrument, a.tradeId, day);
        if (!price) continue;
        const shares = Math.floor(Math.min(a.allocation, cash) / price);
        if (shares === 0) continue;
        positions.push({
          instrumentId: a.instrumentId,
          tradeId: a.tradeId,
          name: data.nameMap.get(a.instrumentId) || "",
          entryDate: day,
          entryPrice: price,
          shares,
          pool: a.pool,
        });
        cash -= shares * price;
        tradesThisMonth++;
      }

      monthlyTrades.push(tradesThisMonth);
      prevMonthPV = currentPV;
      contributionThisMonth = 0;
    }
  }

  const actualFinalPV = monthlyPVs[monthlyPVs.length - 1];
  const bmFinalValue = monthlyBMs[monthlyBMs.length - 1];
  const totalTradesAll = monthlyTrades.reduce((s, t) => s + t, 0);

  log(
    `Backtest complete. ${monthCount} months, final PV: ${Math.round(actualFinalPV).toLocaleString("sv-SE")} SEK`,
  );
  log(`Monthly returns extracted: ${monthlyReturns.length}`);
  log(`Total trades: ${totalTradesAll}`);
  log("");

  // ─── PART 1: Monte Carlo Return Shuffle ────────────────────────────────
  log("═".repeat(80));
  log("MONTE CARLO RETURN SHUFFLE — 10,000 SIMULATIONS");
  log("═".repeat(80));
  log("");
  log("Question: How much of the result depends on the ORDER of returns?");
  log("Method: Take the actual monthly returns, shuffle them randomly,");
  log("        compound with the same DCA schedule. Repeat 10,000 times.");
  log("");

  const rng = mulberry32(42); // reproducible seed
  const terminalValues: number[] = [];

  for (let sim = 0; sim < SIMULATIONS; sim++) {
    const shuffled = shuffle(monthlyReturns, rng);
    let pv = INITIAL_CAPITAL;
    for (let m = 0; m < shuffled.length; m++) {
      pv += monthlyContributions[m]; // add contribution
      pv *= 1 + shuffled[m]; // apply return
    }
    terminalValues.push(pv);
  }

  terminalValues.sort((a, b) => a - b);
  const median = percentile(terminalValues, 50);
  const p5 = percentile(terminalValues, 5);
  const p25 = percentile(terminalValues, 25);
  const p75 = percentile(terminalValues, 75);
  const p95 = percentile(terminalValues, 95);
  const mean =
    terminalValues.reduce((s, v) => s + v, 0) / terminalValues.length;
  const beatActual = terminalValues.filter((v) => v >= actualFinalPV).length;
  const beatBenchmark = terminalValues.filter((v) => v >= bmFinalValue).length;

  log("RESULTS:");
  log("─".repeat(80));
  log(
    `  Actual final value:      ${Math.round(actualFinalPV).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  Benchmark final value:   ${Math.round(bmFinalValue).toLocaleString("sv-SE")} SEK`,
  );
  log("");
  log("  Shuffled distribution:");
  log(
    `    5th percentile:        ${Math.round(p5).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `    25th percentile:       ${Math.round(p25).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `    Median (50th):         ${Math.round(median).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `    Mean:                  ${Math.round(mean).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `    75th percentile:       ${Math.round(p75).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `    95th percentile:       ${Math.round(p95).toLocaleString("sv-SE")} SEK`,
  );
  log("");
  log(
    `  Actual vs shuffled median: ${actualFinalPV > median ? "ABOVE" : "BELOW"} (${((actualFinalPV / median - 1) * 100).toFixed(1)}%)`,
  );
  log(
    `  Sims beating actual:       ${beatActual} / ${SIMULATIONS} (${((beatActual / SIMULATIONS) * 100).toFixed(2)}%)`,
  );
  log(
    `  Sims beating benchmark:    ${beatBenchmark} / ${SIMULATIONS} (${((beatBenchmark / SIMULATIONS) * 100).toFixed(1)}%)`,
  );
  log("");
  log("INTERPRETATION:");
  if (beatActual < SIMULATIONS * 0.05) {
    log("  → Your actual path is in the TOP 5% of all possible orderings.");
    log(
      "    You got LUCKY with sequencing — big winners came when the portfolio",
    );
    log("    was already large (compounding effect). The returns are real,");
    log("    but don't expect the same terminal value next time.");
  } else if (beatActual < SIMULATIONS * 0.25) {
    log("  → Your actual path is above average but not extreme.");
    log("    Mild sequencing luck — reasonable to expect similar outcomes.");
  } else {
    log(
      "  → Your actual path is TYPICAL. The result doesn't depend much on ordering.",
    );
    log("    This is the best case — the alpha is robust to sequencing.");
  }

  // ─── PART 2: Transaction Cost Sensitivity ──────────────────────────────
  log("");
  log("");
  log("═".repeat(80));
  log("TRANSACTION COST SENSITIVITY");
  log("═".repeat(80));
  log("");
  log(
    "Question: At what cost per trade does the strategy stop beating the index?",
  );
  log("Method: Deduct a fixed percentage from portfolio value per trade,");
  log("        re-compound the monthly returns.");
  log("");

  // For each cost level, reduce each monthly return by (trades_that_month * cost * avg_turnover)
  // Simplified: assume each trade costs X% of the capital being traded.
  // With 3 positions fully rebalanced monthly, ~2/3 of portfolio turns over each month.
  const costLevels = [
    0.0, 0.001, 0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03,
  ];

  log(
    `${"Cost/Trade".padStart(12)} ${"Final Value".padStart(16)} ${"Return".padStart(10)} ${"vs Index".padStart(10)} ${"Beats Index?".padStart(13)}`,
  );
  log("─".repeat(70));

  const bmReturn = (bmFinalValue / totalContributed - 1) * 100;
  let breakEvenCost = 0;

  for (const costPerTrade of costLevels) {
    let pv = INITIAL_CAPITAL;
    for (let m = 0; m < monthlyReturns.length; m++) {
      pv += monthlyContributions[m];
      pv *= 1 + monthlyReturns[m];
      // Subtract transaction costs: trades * cost * (pv / positions)
      // Each trade moves ~1/3 of portfolio (one of 3 slots)
      const tradeCost = monthlyTrades[m] * costPerTrade * (pv / 3);
      pv -= tradeCost;
    }
    const ret = (pv / totalContributed - 1) * 100;
    const alpha = ret - bmReturn;
    const beats = alpha > 0 ? "YES" : "NO";
    if (alpha <= 0 && breakEvenCost === 0) breakEvenCost = costPerTrade;
    log(
      `${(costPerTrade * 100).toFixed(2).padStart(10)}%  ${Math.round(pv).toLocaleString("sv-SE").padStart(16)} ${`${ret.toFixed(0)}%`.padStart(10)} ${`${alpha >= 0 ? "+" : ""}${alpha.toFixed(0)}%`.padStart(10)} ${beats.padStart(13)}`,
    );
  }

  log("─".repeat(70));
  if (breakEvenCost > 0) {
    log(`  Break-even cost: ~${(breakEvenCost * 100).toFixed(2)}% per trade`);
  } else {
    log(`  Strategy beats index at all tested cost levels (up to 3%)`);
  }
  log("");
  log("  Realistic Swedish broker costs:");
  log("    Avanza/Nordnet:  ~0.05-0.15% for small orders");
  log("    Spread (small caps): 0.3-1.0% additional");
  log("    Total realistic: 0.5-1.5% round-trip (0.25-0.75% per trade)");

  // ─── PART 3: Bootstrap Confidence Intervals ────────────────────────────
  log("");
  log("");
  log("═".repeat(80));
  log("BOOTSTRAP CONFIDENCE INTERVALS — 10,000 RESAMPLES");
  log("═".repeat(80));
  log("");
  log("Question: What's the realistic range of outcomes?");
  log("Method: Resample monthly returns WITH replacement (some months appear");
  log("        multiple times, some are skipped). This tests robustness to");
  log("        which specific months occurred.");
  log("");

  const rng2 = mulberry32(123);
  const bootstrapValues: number[] = [];

  for (let sim = 0; sim < SIMULATIONS; sim++) {
    let pv = INITIAL_CAPITAL;
    for (let m = 0; m < monthlyReturns.length; m++) {
      pv += monthlyContributions[m];
      // Pick a random month's return (with replacement)
      const randIdx = Math.floor(rng2() * monthlyReturns.length);
      pv *= 1 + monthlyReturns[randIdx];
    }
    bootstrapValues.push(pv);
  }

  bootstrapValues.sort((a, b) => a - b);
  const bMedian = percentile(bootstrapValues, 50);
  const bP5 = percentile(bootstrapValues, 5);
  const bP25 = percentile(bootstrapValues, 25);
  const bP75 = percentile(bootstrapValues, 75);
  const bP95 = percentile(bootstrapValues, 95);
  const bMean =
    bootstrapValues.reduce((s, v) => s + v, 0) / bootstrapValues.length;
  const bBeatBm = bootstrapValues.filter((v) => v >= bmFinalValue).length;
  const bLoseMoney = bootstrapValues.filter((v) => v < totalContributed).length;

  log("RESULTS:");
  log("─".repeat(80));
  log(
    `  5th percentile:         ${Math.round(bP5).toLocaleString("sv-SE")} SEK (${((bP5 / totalContributed - 1) * 100).toFixed(0)}% return)`,
  );
  log(
    `  25th percentile:        ${Math.round(bP25).toLocaleString("sv-SE")} SEK (${((bP25 / totalContributed - 1) * 100).toFixed(0)}% return)`,
  );
  log(
    `  Median:                 ${Math.round(bMedian).toLocaleString("sv-SE")} SEK (${((bMedian / totalContributed - 1) * 100).toFixed(0)}% return)`,
  );
  log(
    `  Mean:                   ${Math.round(bMean).toLocaleString("sv-SE")} SEK (${((bMean / totalContributed - 1) * 100).toFixed(0)}% return)`,
  );
  log(
    `  75th percentile:        ${Math.round(bP75).toLocaleString("sv-SE")} SEK (${((bP75 / totalContributed - 1) * 100).toFixed(0)}% return)`,
  );
  log(
    `  95th percentile:        ${Math.round(bP95).toLocaleString("sv-SE")} SEK (${((bP95 / totalContributed - 1) * 100).toFixed(0)}% return)`,
  );
  log("");
  log(
    `  Prob. of beating index:  ${((bBeatBm / SIMULATIONS) * 100).toFixed(1)}%`,
  );
  log(
    `  Prob. of losing money:   ${((bLoseMoney / SIMULATIONS) * 100).toFixed(2)}%`,
  );
  log("");
  log("  90% confidence interval:");
  log(
    `    ${Math.round(bP5).toLocaleString("sv-SE")} – ${Math.round(bP95).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `    (${((bP5 / totalContributed - 1) * 100).toFixed(0)}% – ${((bP95 / totalContributed - 1) * 100).toFixed(0)}% return)`,
  );

  log("");
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`\nOutput: ${OUTPUT_FILE}`);
  await disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
