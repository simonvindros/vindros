/**
 * VOLATILITY & RISK-ADJUSTED METRICS
 *
 * Computes Sharpe, Sortino, Calmar, and volatility metrics for the Dynamic strategy.
 * Compares risk-adjusted returns to the benchmark.
 * Question: Is the excess return worth the excess volatility?
 */
import dotenv from "dotenv";
dotenv.config();

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
  EngineData,
  Position,
} from "./engine";

const OUTPUT_FILE = path.join(__dirname, "volatility_analysis_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

const run = async () => {
  log("Loading data...");
  const data = await loadEngineData();
  log(`Loaded. ${data.monthEnds.length} month-ends.`);
  log("");

  // Run the dynamic strategy, tracking monthly portfolio values
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let totalContributed = INITIAL_CAPITAL;
  let benchShares =
    INITIAL_CAPITAL /
    (getPriceOnDate(
      data.pricesByInstrument,
      BENCHMARK_ID,
      data.tradingDates[0],
    ) || 1);

  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyKey = 0;

  const strategyValues: number[] = [INITIAL_CAPITAL];
  const benchmarkValues: number[] = [INITIAL_CAPITAL];
  let tradeId = 0;

  for (let mi = 0; mi < data.monthEnds.length; mi++) {
    const day = data.monthEnds[mi];
    const currentYear = parseInt(day.slice(0, 4));
    const currentMonth = parseInt(day.slice(5, 7));
    const currentQ = Math.ceil(currentMonth / 3);
    const qualifyKey = currentYear * 10 + currentQ;

    // Monthly contribution
    cash += MONTHLY_CONTRIBUTION;
    totalContributed += MONTHLY_CONTRIBUTION;
    const bmPrice = getPriceOnDate(data.pricesByInstrument, BENCHMARK_ID, day);
    if (bmPrice) benchShares += MONTHLY_CONTRIBUTION / bmPrice;

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

    // Calculate current PV
    let currentPV = cash;
    for (const pos of positions) {
      const p =
        getPriceOnDate(data.pricesByInstrument, pos.tradeId, day) ||
        pos.entryPrice;
      currentPV += pos.shares * p;
    }

    // Rebalance
    const allCandidates = getAllCandidates(data, day, qualifiedSmallCaps);
    const { allocations } = allocatePositions(
      data,
      allCandidates,
      currentPV,
      day,
    );
    const selectedIds = new Set(allocations.map((a) => a.instrumentId));

    // Sell non-selected
    for (const pos of positions) {
      if (!selectedIds.has(pos.instrumentId)) {
        const price = getPriceOnDate(data.pricesByInstrument, pos.tradeId, day);
        if (price) cash += price * pos.shares;
      }
    }
    positions = positions.filter((p) => selectedIds.has(p.instrumentId));

    // Rebalance existing + buy new
    const allocationMap = new Map(allocations.map((a) => [a.instrumentId, a]));
    for (const pos of positions) {
      const alloc = allocationMap.get(pos.instrumentId);
      if (!alloc) continue;
      const price = getPriceOnDate(data.pricesByInstrument, pos.tradeId, day);
      if (!price) continue;
      const currentValue = pos.shares * price;
      const target = alloc.allocation;
      if (currentValue > target * 1.05) {
        const sellShares = Math.floor((currentValue - target) / price);
        cash += sellShares * price;
        pos.shares -= sellShares;
      } else if (currentValue < target * 0.95 && cash > 0) {
        const buyShares = Math.floor(
          Math.min(target - currentValue, cash) / price,
        );
        cash -= buyShares * price;
        pos.shares += buyShares;
      }
    }

    const heldIds = new Set(positions.map((p) => p.instrumentId));
    for (const a of allocations) {
      if (heldIds.has(a.instrumentId)) continue;
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
    }

    // Record end-of-month values
    let finalPV = cash;
    for (const pos of positions) {
      const p =
        getPriceOnDate(data.pricesByInstrument, pos.tradeId, day) ||
        pos.entryPrice;
      finalPV += pos.shares * p;
    }
    strategyValues.push(finalPV);
    benchmarkValues.push(
      bmPrice
        ? benchShares * bmPrice
        : benchmarkValues[benchmarkValues.length - 1],
    );
  }

  // ─── Compute metrics ───────────────────────────────────────────────────
  // Monthly returns (accounting for contributions)
  const stratMonthlyReturns: number[] = [];
  const benchMonthlyReturns: number[] = [];
  for (let i = 1; i < strategyValues.length; i++) {
    const contrib = MONTHLY_CONTRIBUTION;
    stratMonthlyReturns.push(
      (strategyValues[i] - strategyValues[i - 1] - contrib) /
        strategyValues[i - 1],
    );
    benchMonthlyReturns.push(
      (benchmarkValues[i] - benchmarkValues[i - 1] - contrib) /
        benchmarkValues[i - 1],
    );
  }

  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const std = (arr: number[]) => {
    const m = mean(arr);
    return Math.sqrt(
      arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1),
    );
  };
  const downstd = (arr: number[]) => {
    const negatives = arr.filter((r) => r < 0);
    if (negatives.length < 2) return 0.001;
    return Math.sqrt(
      negatives.reduce((s, v) => s + v ** 2, 0) / (negatives.length - 1),
    );
  };

  const maxDD = (
    values: number[],
  ): { dd: number; peakDate: number; troughDate: number } => {
    let peak = values[0];
    let peakIdx = 0;
    let maxDd = 0;
    let maxPeakIdx = 0;
    let maxTroughIdx = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] > peak) {
        peak = values[i];
        peakIdx = i;
      }
      const dd = (peak - values[i]) / peak;
      if (dd > maxDd) {
        maxDd = dd;
        maxPeakIdx = peakIdx;
        maxTroughIdx = i;
      }
    }
    return { dd: maxDd, peakDate: maxPeakIdx, troughDate: maxTroughIdx };
  };

  // Underwater periods
  const underwaterMonths = (values: number[]): number => {
    let peak = values[0];
    let count = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] > peak) peak = values[i];
      else count++;
    }
    return count;
  };

  const stratMean = mean(stratMonthlyReturns);
  const stratStd = std(stratMonthlyReturns);
  const stratDownStd = downstd(stratMonthlyReturns);
  const benchMean = mean(benchMonthlyReturns);
  const benchStd = std(benchMonthlyReturns);
  const benchDownStd = downstd(benchMonthlyReturns);

  const riskFreeMonthly = 0.03 / 12; // assume 3% annual risk-free
  const stratSharpe =
    ((stratMean - riskFreeMonthly) / stratStd) * Math.sqrt(12);
  const benchSharpe =
    ((benchMean - riskFreeMonthly) / benchStd) * Math.sqrt(12);
  const stratSortino =
    ((stratMean - riskFreeMonthly) / stratDownStd) * Math.sqrt(12);
  const benchSortino =
    ((benchMean - riskFreeMonthly) / benchDownStd) * Math.sqrt(12);

  const stratDD = maxDD(strategyValues);
  const benchDD = maxDD(benchmarkValues);
  const months = data.monthEnds.length;
  const stratCAGR =
    Math.pow(
      strategyValues[strategyValues.length - 1] / INITIAL_CAPITAL,
      12 / months,
    ) - 1;
  const benchCAGR =
    Math.pow(
      benchmarkValues[benchmarkValues.length - 1] / INITIAL_CAPITAL,
      12 / months,
    ) - 1;
  const stratCalmar = stratCAGR / Math.max(stratDD.dd, 0.01);
  const benchCalmar = benchCAGR / Math.max(benchDD.dd, 0.01);

  const stratUnderwater = underwaterMonths(strategyValues);
  const benchUnderwater = underwaterMonths(benchmarkValues);

  // Win rate (months with positive return)
  const stratWinRate =
    stratMonthlyReturns.filter((r) => r > 0).length /
    stratMonthlyReturns.length;
  const benchWinRate =
    benchMonthlyReturns.filter((r) => r > 0).length /
    benchMonthlyReturns.length;

  // Best/worst months
  const stratBest = Math.max(...stratMonthlyReturns);
  const stratWorst = Math.min(...stratMonthlyReturns);
  const benchBest = Math.max(...benchMonthlyReturns);
  const benchWorst = Math.min(...benchMonthlyReturns);

  log("═".repeat(90));
  log("VOLATILITY & RISK-ADJUSTED PERFORMANCE");
  log("═".repeat(90));
  log(
    `Period: ${data.monthEnds[0]} to ${data.monthEnds[months - 1]} (${months} months / ${(months / 12).toFixed(1)} years)`,
  );
  log(`Risk-free rate assumed: 3.0% annual`);
  log("");

  log("─".repeat(90));
  log(
    `${"Metric".padEnd(35)} ${"Dynamic(3)".padStart(14)} ${"OMXSPI".padStart(14)}`,
  );
  log("─".repeat(90));
  log(
    `${"Final portfolio value".padEnd(35)} ${strategyValues[strategyValues.length - 1].toLocaleString("sv-SE", { maximumFractionDigits: 0 }).padStart(14)} ${benchmarkValues[benchmarkValues.length - 1].toLocaleString("sv-SE", { maximumFractionDigits: 0 }).padStart(14)}`,
  );
  log(
    `${"Total contributed".padEnd(35)} ${totalContributed.toLocaleString("sv-SE").padStart(14)} ${totalContributed.toLocaleString("sv-SE").padStart(14)}`,
  );
  log(
    `${"Total return".padEnd(35)} ${((strategyValues[strategyValues.length - 1] / totalContributed - 1) * 100).toFixed(0).padStart(13)}% ${((benchmarkValues[benchmarkValues.length - 1] / totalContributed - 1) * 100).toFixed(0).padStart(13)}%`,
  );
  log(
    `${"CAGR (from initial capital)".padEnd(35)} ${(stratCAGR * 100).toFixed(1).padStart(13)}% ${(benchCAGR * 100).toFixed(1).padStart(13)}%`,
  );
  log("");
  log(`${"─── VOLATILITY ───".padEnd(35)}`);
  log(
    `${"Monthly mean return".padEnd(35)} ${(stratMean * 100).toFixed(2).padStart(13)}% ${(benchMean * 100).toFixed(2).padStart(13)}%`,
  );
  log(
    `${"Monthly std dev".padEnd(35)} ${(stratStd * 100).toFixed(2).padStart(13)}% ${(benchStd * 100).toFixed(2).padStart(13)}%`,
  );
  log(
    `${"Annualized volatility".padEnd(35)} ${(stratStd * Math.sqrt(12) * 100).toFixed(1).padStart(13)}% ${(benchStd * Math.sqrt(12) * 100).toFixed(1).padStart(13)}%`,
  );
  log(
    `${"Downside deviation (monthly)".padEnd(35)} ${(stratDownStd * 100).toFixed(2).padStart(13)}% ${(benchDownStd * 100).toFixed(2).padStart(13)}%`,
  );
  log("");
  log(`${"─── RISK-ADJUSTED RATIOS ───".padEnd(35)}`);
  log(
    `${"Sharpe ratio".padEnd(35)} ${stratSharpe.toFixed(2).padStart(14)} ${benchSharpe.toFixed(2).padStart(14)}`,
  );
  log(
    `${"Sortino ratio".padEnd(35)} ${stratSortino.toFixed(2).padStart(14)} ${benchSortino.toFixed(2).padStart(14)}`,
  );
  log(
    `${"Calmar ratio (CAGR/MaxDD)".padEnd(35)} ${stratCalmar.toFixed(2).padStart(14)} ${benchCalmar.toFixed(2).padStart(14)}`,
  );
  log("");
  log(`${"─── DRAWDOWN ───".padEnd(35)}`);
  log(
    `${"Max drawdown".padEnd(35)} ${(-stratDD.dd * 100).toFixed(1).padStart(13)}% ${(-benchDD.dd * 100).toFixed(1).padStart(13)}%`,
  );
  log(
    `${"DD peak month".padEnd(35)} ${String(stratDD.peakDate).padStart(14)} ${String(benchDD.peakDate).padStart(14)}`,
  );
  log(
    `${"DD trough month".padEnd(35)} ${String(stratDD.troughDate).padStart(14)} ${String(benchDD.troughDate).padStart(14)}`,
  );
  log(
    `${"Months underwater".padEnd(35)} ${`${stratUnderwater}/${months}`.padStart(14)} ${`${benchUnderwater}/${months}`.padStart(14)}`,
  );
  log(
    `${"% time underwater".padEnd(35)} ${((stratUnderwater / months) * 100).toFixed(1).padStart(13)}% ${((benchUnderwater / months) * 100).toFixed(1).padStart(13)}%`,
  );
  log("");
  log(`${"─── MONTHLY DISTRIBUTION ───".padEnd(35)}`);
  log(
    `${"Win rate (months > 0)".padEnd(35)} ${(stratWinRate * 100).toFixed(1).padStart(13)}% ${(benchWinRate * 100).toFixed(1).padStart(13)}%`,
  );
  log(
    `${"Best month".padEnd(35)} ${(stratBest * 100).toFixed(1).padStart(13)}% ${(benchBest * 100).toFixed(1).padStart(13)}%`,
  );
  log(
    `${"Worst month".padEnd(35)} ${(stratWorst * 100).toFixed(1).padStart(13)}% ${(benchWorst * 100).toFixed(1).padStart(13)}%`,
  );
  log(
    `${"Skewness".padEnd(35)} ${skewness(stratMonthlyReturns).toFixed(2).padStart(14)} ${skewness(benchMonthlyReturns).toFixed(2).padStart(14)}`,
  );
  log(
    `${"Kurtosis (excess)".padEnd(35)} ${kurtosis(stratMonthlyReturns).toFixed(2).padStart(14)} ${kurtosis(benchMonthlyReturns).toFixed(2).padStart(14)}`,
  );

  log("");
  log("─".repeat(90));
  log("INTERPRETATION:");
  log("─".repeat(90));
  log(
    `  Sharpe premium: ${(stratSharpe - benchSharpe).toFixed(2)} (Dynamic minus Benchmark)`,
  );
  if (stratSharpe > benchSharpe) {
    log("  → Strategy delivers better risk-adjusted returns than the index.");
  } else {
    log(
      "  → WARNING: Index has better risk-adjusted returns. Extra volatility not compensated.",
    );
  }
  log(
    `  Volatility ratio: ${(stratStd / benchStd).toFixed(2)}x benchmark volatility`,
  );
  log(
    `  To replicate Dynamic's return with leveraged index: ${(stratCAGR / Math.max(benchCAGR, 0.01)).toFixed(1)}x leverage needed`,
  );

  log("");
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`Output: ${OUTPUT_FILE}`);
  await disconnect();
};

function skewness(arr: number[]): number {
  const n = arr.length;
  const m = arr.reduce((s, v) => s + v, 0) / n;
  const s = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  if (s === 0) return 0;
  return (
    (n / ((n - 1) * (n - 2))) *
    arr.reduce((sum, v) => sum + ((v - m) / s) ** 3, 0)
  );
}

function kurtosis(arr: number[]): number {
  const n = arr.length;
  const m = arr.reduce((s, v) => s + v, 0) / n;
  const s = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  if (s === 0) return 0;
  const k =
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) *
    arr.reduce((sum, v) => sum + ((v - m) / s) ** 4, 0);
  return k - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
