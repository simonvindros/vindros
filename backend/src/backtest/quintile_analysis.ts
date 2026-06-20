/**
 * QUINTILE ANALYSIS — Signal Monotonicity Test
 *
 * Split the entire candidate universe into 5 quintiles by regression slope rank.
 * Run each quintile as a 15-position equal-weight portfolio (monthly rebalance).
 * If the signal is real, alpha should decrease monotonically: Q1 > Q2 > Q3 > Q4 > Q5.
 * If Q1 and Q5 are similar → the signal is driven by outliers, not systematic alpha.
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadEngineData,
  getPriceOnDate,
  getAllCandidates,
  getQualifiedSmallCaps,
  latestAvailableQuarter,
  disconnect,
  INITIAL_CAPITAL,
  MONTHLY_CONTRIBUTION,
  BENCHMARK_ID,
  EngineData,
  Candidate,
} from "./engine";

const OUTPUT_FILE = path.join(__dirname, "quintile_analysis_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

const NUM_QUINTILES = 5;
const POSITIONS_PER_QUINTILE = 15;

function runQuintileBacktest(data: EngineData) {
  // Track portfolio value for each quintile + benchmark
  const quintileValues: number[][] = Array.from(
    { length: NUM_QUINTILES },
    () => [],
  );
  const benchValues: number[] = [];

  // Portfolio state per quintile
  const portfolios: Array<{
    cash: number;
    positions: Map<number, { shares: number; entryPrice: number }>;
  }> = Array.from({ length: NUM_QUINTILES }, () => ({
    cash: INITIAL_CAPITAL,
    positions: new Map(),
  }));

  let benchShares =
    INITIAL_CAPITAL /
    (getPriceOnDate(
      data.pricesByInstrument,
      BENCHMARK_ID,
      data.tradingDates[0],
    ) || 1);
  let totalContributed = INITIAL_CAPITAL;
  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyKey = 0;

  // Monthly returns tracking
  const monthlyReturns: number[][] = Array.from(
    { length: NUM_QUINTILES },
    () => [],
  );
  const benchMonthlyReturns: number[] = [];
  let prevQuintileValues = Array(NUM_QUINTILES).fill(INITIAL_CAPITAL);
  let prevBenchValue = INITIAL_CAPITAL;

  for (let mi = 0; mi < data.monthEnds.length; mi++) {
    const day = data.monthEnds[mi];
    const currentYear = parseInt(day.slice(0, 4));
    const currentMonth = parseInt(day.slice(5, 7));
    const currentQ = Math.ceil(currentMonth / 3);
    const qualifyKey = currentYear * 10 + currentQ;

    if (qualifyKey > lastQualifyKey) {
      const avail = latestAvailableQuarter(day);
      qualifiedSmallCaps = getQualifiedSmallCaps(
        data.kpiData,
        data.qKpiData,
        data.smallIds,
        currentYear - 1,
        avail.year,
        avail.period,
      );
      lastQualifyKey = qualifyKey;
    }

    // Monthly contribution
    for (const pf of portfolios) pf.cash += MONTHLY_CONTRIBUTION;
    totalContributed += MONTHLY_CONTRIBUTION;
    const bmPrice = getPriceOnDate(data.pricesByInstrument, BENCHMARK_ID, day);
    if (bmPrice) benchShares += MONTHLY_CONTRIBUTION / bmPrice;

    // Get all candidates sorted by slope
    const allCandidates = getAllCandidates(data, day, qualifiedSmallCaps);

    // Split into quintiles
    const quintileSize = Math.max(
      1,
      Math.floor(allCandidates.length / NUM_QUINTILES),
    );
    const quintiles: Candidate[][] = [];
    for (let q = 0; q < NUM_QUINTILES; q++) {
      const start = q * quintileSize;
      const end =
        q === NUM_QUINTILES - 1 ? allCandidates.length : (q + 1) * quintileSize;
      quintiles.push(allCandidates.slice(start, end));
    }

    // Rebalance each quintile portfolio
    for (let q = 0; q < NUM_QUINTILES; q++) {
      const pf = portfolios[q];
      const picks = quintiles[q]?.slice(0, POSITIONS_PER_QUINTILE) || [];

      // Sell everything
      let pv = pf.cash;
      for (const [instId, pos] of pf.positions) {
        const price = getPriceOnDate(data.pricesByInstrument, instId, day);
        if (price) pv += pos.shares * price;
      }
      pf.positions.clear();
      pf.cash = pv;

      // Buy equally into picks
      if (picks.length > 0) {
        const perStock = pf.cash / picks.length;
        for (const c of picks) {
          const price = getPriceOnDate(
            data.pricesByInstrument,
            c.instrumentId,
            day,
          );
          if (!price) continue;
          const shares = Math.floor(perStock / price);
          if (shares === 0) continue;
          pf.positions.set(c.instrumentId, { shares, entryPrice: price });
          pf.cash -= shares * price;
        }
      }

      // Record value
      let finalPV = pf.cash;
      for (const [instId, pos] of pf.positions) {
        const price =
          getPriceOnDate(data.pricesByInstrument, instId, day) ||
          pos.entryPrice;
        finalPV += pos.shares * price;
      }
      quintileValues[q].push(finalPV);

      // Monthly return
      if (mi > 0) {
        monthlyReturns[q].push(
          (finalPV - prevQuintileValues[q]) / prevQuintileValues[q],
        );
      }
      prevQuintileValues[q] = finalPV;
    }

    // Benchmark value
    const benchPV = bmPrice ? benchShares * bmPrice : prevBenchValue;
    benchValues.push(benchPV);
    if (mi > 0) {
      benchMonthlyReturns.push((benchPV - prevBenchValue) / prevBenchValue);
    }
    prevBenchValue = benchPV;
  }

  return {
    quintileValues,
    benchValues,
    monthlyReturns,
    benchMonthlyReturns,
    totalContributed,
  };
}

function calcCAGR(startVal: number, endVal: number, months: number): number {
  if (startVal <= 0 || months === 0) return 0;
  return (Math.pow(endVal / startVal, 12 / months) - 1) * 100;
}

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1),
  );
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(12); // annualized
}

function calcMaxDD(values: number[]): number {
  let peak = values[0] || 0;
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

const run = async () => {
  log("Loading data...");
  const data = await loadEngineData();
  log(`Loaded. ${data.monthEnds.length} month-ends.`);
  log("");

  const {
    quintileValues,
    benchValues,
    monthlyReturns,
    benchMonthlyReturns,
    totalContributed,
  } = runQuintileBacktest(data);

  log("═".repeat(90));
  log("QUINTILE ANALYSIS — SIGNAL MONOTONICITY");
  log("═".repeat(90));
  log(
    `Universe: all qualified candidates each month, split into ${NUM_QUINTILES} quintiles by slope rank`,
  );
  log(
    `Each quintile: top ${POSITIONS_PER_QUINTILE} stocks, equal-weight, monthly rebalance`,
  );
  log(`Q1 = highest slope (best signal), Q5 = lowest slope (worst signal)`);
  log(
    `Period: ${data.monthEnds[0]} to ${data.monthEnds[data.monthEnds.length - 1]} (${data.monthEnds.length} months)`,
  );
  log("");

  log("─".repeat(90));
  log(
    `${"Quintile".padEnd(12)} ${"Final Value".padStart(14)} ${"Total Return".padStart(14)} ${"CAGR".padStart(8)} ${"Sharpe".padStart(8)} ${"Max DD".padStart(8)} ${"vs Bench".padStart(10)}`,
  );
  log("─".repeat(90));

  const benchFinal = benchValues[benchValues.length - 1];
  const benchReturn =
    ((benchFinal - totalContributed) / totalContributed) * 100;
  const benchCAGR = calcCAGR(
    INITIAL_CAPITAL,
    benchFinal,
    data.monthEnds.length,
  );
  const benchSharpe = calcSharpe(benchMonthlyReturns);
  const benchDD = calcMaxDD(benchValues);

  for (let q = 0; q < NUM_QUINTILES; q++) {
    const vals = quintileValues[q];
    const final = vals[vals.length - 1];
    const totalReturn = ((final - totalContributed) / totalContributed) * 100;
    const cagr = calcCAGR(INITIAL_CAPITAL, final, data.monthEnds.length);
    const sharpe = calcSharpe(monthlyReturns[q]);
    const maxDD = calcMaxDD(vals);
    const alpha = totalReturn - benchReturn;

    log(
      `${"Q" + (q + 1) + (q === 0 ? " (BEST)" : q === 4 ? " (WORST)" : "").padEnd(8)}`.padEnd(
        12,
      ) +
        `${final.toLocaleString("sv-SE", { maximumFractionDigits: 0 })} kr`.padStart(
          14,
        ) +
        `${totalReturn.toFixed(0)}%`.padStart(14) +
        `${cagr.toFixed(1)}%`.padStart(8) +
        `${sharpe.toFixed(2)}`.padStart(8) +
        `${(-maxDD * 100).toFixed(1)}%`.padStart(8) +
        `${alpha >= 0 ? "+" : ""}${alpha.toFixed(0)}%`.padStart(10),
    );
  }

  log(
    `${"OMXSPI".padEnd(12)}` +
      `${benchFinal.toLocaleString("sv-SE", { maximumFractionDigits: 0 })} kr`.padStart(
        14,
      ) +
      `${benchReturn.toFixed(0)}%`.padStart(14) +
      `${benchCAGR.toFixed(1)}%`.padStart(8) +
      `${benchSharpe.toFixed(2)}`.padStart(8) +
      `${(-benchDD * 100).toFixed(1)}%`.padStart(8) +
      `${"—"}`.padStart(10),
  );

  log("");
  log("─".repeat(90));
  log("MONOTONICITY CHECK:");
  log("─".repeat(90));
  const quintileReturns = quintileValues.map((vals) => {
    const final = vals[vals.length - 1];
    return ((final - totalContributed) / totalContributed) * 100;
  });

  let isMonotone = true;
  for (let i = 0; i < quintileReturns.length - 1; i++) {
    if (quintileReturns[i] < quintileReturns[i + 1]) {
      isMonotone = false;
      break;
    }
  }

  log(
    `  Q1: ${quintileReturns[0].toFixed(0)}%  Q2: ${quintileReturns[1].toFixed(0)}%  Q3: ${quintileReturns[2].toFixed(0)}%  Q4: ${quintileReturns[3].toFixed(0)}%  Q5: ${quintileReturns[4].toFixed(0)}%`,
  );
  log(
    `  Spread (Q1 - Q5): ${(quintileReturns[0] - quintileReturns[4]).toFixed(0)} percentage points`,
  );
  log(
    `  Monotonic: ${isMonotone ? "YES ✓ — signal works systematically" : "NO — investigating..."}`,
  );

  if (!isMonotone) {
    const violations: string[] = [];
    for (let i = 0; i < quintileReturns.length - 1; i++) {
      if (quintileReturns[i] < quintileReturns[i + 1]) {
        violations.push(
          `Q${i + 1} (${quintileReturns[i].toFixed(0)}%) < Q${i + 2} (${quintileReturns[i + 1].toFixed(0)}%)`,
        );
      }
    }
    log(`  Violations: ${violations.join(", ")}`);
    log(
      `  NOTE: Minor inversions in middle quintiles are common and acceptable.`,
    );
    log(
      `  Key test: Q1 >> Q5 and Q1 >> Q3. If true, signal has real predictive power.`,
    );
  }

  log(
    `\n  Q1/Q5 ratio: ${(quintileReturns[0] / Math.max(quintileReturns[4], 1)).toFixed(1)}x`,
  );
  log(
    `  Q1/Q3 ratio: ${(quintileReturns[0] / Math.max(quintileReturns[2], 1)).toFixed(1)}x`,
  );

  log("");
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`Output: ${OUTPUT_FILE}`);
  await disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
