/**
 * SIMPLE SIGNAL COMPARISON — Is regression over-engineered?
 *
 * Replace the 60-day linear regression slope with simple N-month returns:
 * - 1-month return (21 trading days)
 * - 3-month return (63 trading days)
 * - 6-month return (126 trading days)
 * - 12-month return (252 trading days)
 *
 * Run each as a 3-slot dynamic portfolio and compare final returns.
 * If simple momentum matches regression → regression adds no value.
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadEngineData,
  getPriceOnDate,
  getPriceIndex,
  allocatePositions,
  getQualifiedSmallCaps,
  latestAvailableQuarter,
  disconnect,
  INITIAL_CAPITAL,
  MONTHLY_CONTRIBUTION,
  BENCHMARK_ID,
  MIN_PRICE,
  MIN_R2,
  REG_SHORT,
  EngineData,
  Candidate,
  Position,
} from "./engine";
import { linearRegression } from "./utils";

const OUTPUT_FILE = path.join(__dirname, "simple_signal_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

type SignalFn = (
  data: EngineData,
  instId: number,
  dateStr: string,
) => number | undefined;

// Signal: N-day simple momentum (return over last N days)
function momentumSignal(lookback: number): SignalFn {
  return (data, instId, dateStr) => {
    const prices = data.pricesByInstrument.get(instId);
    if (!prices) return undefined;
    const idx = getPriceIndex(data.pricesByInstrument, instId, dateStr);
    if (idx < lookback) return undefined;
    const lastDate = prices[idx].date.toISOString().slice(0, 10);
    const daysDiff =
      (new Date(dateStr).getTime() - new Date(lastDate).getTime()) / 86400000;
    if (daysDiff > 7) return undefined;
    const current = prices[idx].close;
    const past = prices[idx - lookback].close;
    if (past <= 0) return undefined;
    return current / past - 1; // simple return
  };
}

// Signal: regression slope (the original)
function regressionSignal(): SignalFn {
  return (data, instId, dateStr) => {
    const prices = data.pricesByInstrument.get(instId);
    if (!prices) return undefined;
    const idx = getPriceIndex(data.pricesByInstrument, instId, dateStr);
    if (idx < REG_SHORT) return undefined;
    const lastDate = prices[idx].date.toISOString().slice(0, 10);
    const daysDiff =
      (new Date(dateStr).getTime() - new Date(lastDate).getTime()) / 86400000;
    if (daysDiff > 7) return undefined;
    const closes = prices.map((p) => p.close);
    const slice = closes.slice(idx - REG_SHORT + 1, idx + 1);
    const reg = linearRegression(slice, Math.floor(REG_SHORT * 0.67));
    if (reg.slope <= 0 || reg.r2 < MIN_R2) return undefined;
    return reg.slope * 252;
  };
}

function getCandidatesWithSignal(
  data: EngineData,
  dateStr: string,
  qualifiedSmall: Set<number>,
  signal: SignalFn,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const instId of data.largeMidIdSet) {
    const price = getPriceOnDate(data.pricesByInstrument, instId, dateStr);
    if (!price || price < MIN_PRICE) continue;
    const score = signal(data, instId, dateStr);
    if (score === undefined || score <= 0) continue;
    candidates.push({
      instrumentId: instId,
      slope: score,
      r2: 1,
      pool: "large",
    });
  }
  for (const instId of qualifiedSmall) {
    const price = getPriceOnDate(data.pricesByInstrument, instId, dateStr);
    if (!price || price < MIN_PRICE) continue;
    const score = signal(data, instId, dateStr);
    if (score === undefined || score <= 0) continue;
    candidates.push({
      instrumentId: instId,
      slope: score,
      r2: 1,
      pool: "small",
    });
  }
  candidates.sort((a, b) => b.slope - a.slope);

  // Deduplicate by company
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of candidates) {
    const name = data.nameMap.get(c.instrumentId) || String(c.instrumentId);
    const company = name.replace(/ [AB]$/, "");
    if (seen.has(company)) continue;
    seen.add(company);
    deduped.push(c);
  }
  return deduped;
}

function runBacktestWithSignal(
  data: EngineData,
  signal: SignalFn,
): { finalPV: number; monthlyReturns: number[]; maxDD: number } {
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyKey = 0;
  const values: number[] = [INITIAL_CAPITAL];

  for (let mi = 0; mi < data.monthEnds.length; mi++) {
    const day = data.monthEnds[mi];
    const currentYear = parseInt(day.slice(0, 4));
    const currentMonth = parseInt(day.slice(5, 7));
    const currentQ = Math.ceil(currentMonth / 3);
    const qualifyKey = currentYear * 10 + currentQ;

    cash += MONTHLY_CONTRIBUTION;

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

    // Current PV
    let currentPV = cash;
    for (const pos of positions) {
      const p =
        getPriceOnDate(data.pricesByInstrument, pos.tradeId, day) ||
        pos.entryPrice;
      currentPV += pos.shares * p;
    }

    // Get candidates with this signal
    const candidates = getCandidatesWithSignal(
      data,
      day,
      qualifiedSmallCaps,
      signal,
    );
    const { allocations } = allocatePositions(data, candidates, currentPV, day);
    const selectedIds = new Set(allocations.map((a) => a.instrumentId));

    // Sell non-selected
    for (const pos of positions) {
      if (!selectedIds.has(pos.instrumentId)) {
        const price = getPriceOnDate(data.pricesByInstrument, pos.tradeId, day);
        if (price) cash += price * pos.shares;
      }
    }
    positions = positions.filter((p) => selectedIds.has(p.instrumentId));

    // Buy new
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

    // Record value
    let finalPV = cash;
    for (const pos of positions) {
      const p =
        getPriceOnDate(data.pricesByInstrument, pos.tradeId, day) ||
        pos.entryPrice;
      finalPV += pos.shares * p;
    }
    values.push(finalPV);
  }

  // Compute metrics
  const monthlyReturns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    monthlyReturns.push(
      (values[i] - values[i - 1] - MONTHLY_CONTRIBUTION) / values[i - 1],
    );
  }

  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return { finalPV: values[values.length - 1], monthlyReturns, maxDD };
}

const run = async () => {
  log("Loading data...");
  const data = await loadEngineData();
  log(`Loaded. ${data.monthEnds.length} month-ends.`);
  log("");

  const totalContributed =
    INITIAL_CAPITAL + MONTHLY_CONTRIBUTION * data.monthEnds.length;

  const signals: Array<{ name: string; signal: SignalFn }> = [
    { name: "Regression 60d (original)", signal: regressionSignal() },
    { name: "Momentum 21d (1 month)", signal: momentumSignal(21) },
    { name: "Momentum 63d (3 months)", signal: momentumSignal(63) },
    { name: "Momentum 126d (6 months)", signal: momentumSignal(126) },
    { name: "Momentum 252d (12 months)", signal: momentumSignal(252) },
  ];

  log("═".repeat(90));
  log("SIMPLE SIGNAL COMPARISON — IS REGRESSION OVER-ENGINEERED?");
  log("═".repeat(90));
  log(
    `Each signal: 3-slot dynamic allocation, monthly rebalance, same universe & quality gate`,
  );
  log(
    `Period: ${data.monthEnds[0]} to ${data.monthEnds[data.monthEnds.length - 1]} (${data.monthEnds.length} months)`,
  );
  log(`Contributed: ${totalContributed.toLocaleString("sv-SE")} SEK`);
  log("");

  log("─".repeat(90));
  log(
    `${"Signal".padEnd(30)} ${"Final Value".padStart(14)} ${"Return".padStart(10)} ${"Sharpe".padStart(8)} ${"Max DD".padStart(8)} ${"vs Bench".padStart(10)}`,
  );
  log("─".repeat(90));

  // Benchmark
  let benchShares =
    INITIAL_CAPITAL /
    (getPriceOnDate(
      data.pricesByInstrument,
      BENCHMARK_ID,
      data.tradingDates[0],
    ) || 1);
  for (const day of data.monthEnds) {
    const bmPrice = getPriceOnDate(data.pricesByInstrument, BENCHMARK_ID, day);
    if (bmPrice) benchShares += MONTHLY_CONTRIBUTION / bmPrice;
  }
  const benchFinal =
    benchShares *
    (getPriceOnDate(
      data.pricesByInstrument,
      BENCHMARK_ID,
      data.monthEnds[data.monthEnds.length - 1],
    ) || 1);
  const benchReturn = (benchFinal / totalContributed - 1) * 100;

  const results: Array<{
    name: string;
    finalPV: number;
    ret: number;
    sharpe: number;
    maxDD: number;
  }> = [];

  for (const { name, signal } of signals) {
    process.stdout.write(`  Running: ${name}...\r`);
    const result = runBacktestWithSignal(data, signal);
    const ret = (result.finalPV / totalContributed - 1) * 100;
    const mean =
      result.monthlyReturns.reduce((s, v) => s + v, 0) /
      result.monthlyReturns.length;
    const stdev = Math.sqrt(
      result.monthlyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) /
        (result.monthlyReturns.length - 1),
    );
    const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(12) : 0;
    const alpha = ret - benchReturn;

    results.push({
      name,
      finalPV: result.finalPV,
      ret,
      sharpe,
      maxDD: result.maxDD,
    });

    log(
      `${name.padEnd(30)} ${result.finalPV.toLocaleString("sv-SE", { maximumFractionDigits: 0 }).padStart(14)} ${(ret.toFixed(0) + "%").padStart(10)} ${sharpe.toFixed(2).padStart(8)} ${((-result.maxDD * 100).toFixed(1) + "%").padStart(8)} ${(alpha >= 0 ? "+" : "") + alpha.toFixed(0) + "%"}`.padStart(
        10,
      ),
    );
  }

  log(
    `${"OMXSPI (benchmark)".padEnd(30)} ${benchFinal.toLocaleString("sv-SE", { maximumFractionDigits: 0 }).padStart(14)} ${(benchReturn.toFixed(0) + "%").padStart(10)} ${"—".padStart(8)} ${"—".padStart(8)} ${"—".padStart(10)}`,
  );

  log("");
  log("─".repeat(90));
  log("INTERPRETATION:");
  log("─".repeat(90));

  const regResult = results[0];
  const bestSimple = results.slice(1).sort((a, b) => b.ret - a.ret)[0];

  if (bestSimple.ret > regResult.ret * 0.9) {
    log(
      `  ${bestSimple.name} achieves ${((bestSimple.ret / regResult.ret) * 100).toFixed(0)}% of regression's return.`,
    );
    log(
      "  → Regression MAY be over-engineered. Simple momentum captures most of the alpha.",
    );
  } else {
    log(
      `  Best simple signal (${bestSimple.name}): ${bestSimple.ret.toFixed(0)}% vs regression's ${regResult.ret.toFixed(0)}%`,
    );
    log(
      `  → Regression adds meaningful value (+${(regResult.ret - bestSimple.ret).toFixed(0)}% return, ${(regResult.sharpe - bestSimple.sharpe).toFixed(2)} Sharpe premium).`,
    );
  }

  log(
    `\n  Regression's R² filter removes noisy trends — simple momentum has no quality check.`,
  );
  log(
    `  Regression slope is also more stable than raw return (less sensitive to single-day spikes).`,
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
