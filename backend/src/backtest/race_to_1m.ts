/**
 * RACE TO 1M — Full distribution analysis
 *
 * For each starting month (Jul 2006 – Jun 2019), run both strategies:
 * - Dynamic (3 concentrated)
 * - Baseline (15 positions) — simulated as 15 equal-weight from same candidates
 * - Index (OMXSPI DCA)
 * - Spiltan Invest (where data available, from Nov 2011)
 *
 * Reports: months to reach 1M, worst-case paths, distribution,
 *          and "how much worse is the worst dynamic path vs baseline?"
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadEngineData,
  getPriceOnDate,
  getPriceIndex,
  getAllCandidates,
  allocatePositions,
  getQualifiedSmallCaps,
  latestAvailableQuarter,
  disconnect,
  INITIAL_CAPITAL,
  MONTHLY_CONTRIBUTION,
  BENCHMARK_ID,
  REG_SHORT,
  MIN_PRICE,
  Position,
  EngineData,
  Candidate,
  Allocation,
  MAX_ADV_FRACTION,
  getEffectiveADV,
} from "./engine";
import { linearRegression } from "./utils";
import { prisma } from "../lib/prisma";

const OUTPUT_FILE = path.join(__dirname, "race_to_1m_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

const TARGET = 1_000_000;
const SPILTAN_ID = 2294;

// Get candidates with a custom R² threshold
function getAllCandidatesWithR2(
  data: EngineData,
  dateStr: string,
  qualifiedSmall: Set<number>,
  minR2: number,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const instId of data.largeMidIdSet) {
    const price = getPriceOnDate(data.pricesByInstrument, instId, dateStr);
    if (!price || price < MIN_PRICE) continue;
    const reg = getRegScore(data, instId, dateStr, minR2);
    if (!reg) continue;
    candidates.push({
      instrumentId: instId,
      slope: reg.slope,
      r2: reg.r2,
      pool: "large",
    });
  }
  for (const instId of qualifiedSmall) {
    const price = getPriceOnDate(data.pricesByInstrument, instId, dateStr);
    if (!price || price < MIN_PRICE) continue;
    const reg = getRegScore(data, instId, dateStr, minR2);
    if (!reg) continue;
    candidates.push({
      instrumentId: instId,
      slope: reg.slope,
      r2: reg.r2,
      pool: "small",
    });
  }
  candidates.sort((a, b) => b.slope - a.slope);
  const seenCompanies = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of candidates) {
    const rawName = data.nameMap.get(c.instrumentId) || String(c.instrumentId);
    const companyName = rawName.replace(/ [AB]$/, "");
    if (seenCompanies.has(companyName)) continue;
    seenCompanies.add(companyName);
    deduped.push(c);
  }
  return deduped;
}

function getRegScore(
  data: EngineData,
  instId: number,
  dateStr: string,
  minR2: number,
): { slope: number; r2: number } | undefined {
  const prices = data.pricesByInstrument.get(instId);
  if (!prices) return undefined;
  const idx = getPriceIndex(data.pricesByInstrument, instId, dateStr);
  if (idx < REG_SHORT) return undefined;
  const lastPriceDate = prices[idx].date.toISOString().slice(0, 10);
  const daysDiff =
    (new Date(dateStr).getTime() - new Date(lastPriceDate).getTime()) /
    86400000;
  if (daysDiff > 7) return undefined;
  const closes = prices.map((p) => p.close);
  const slice = closes.slice(idx - REG_SHORT + 1, idx + 1);
  const reg = linearRegression(slice, Math.floor(REG_SHORT * 0.67));
  if (reg.slope <= 0 || reg.r2 < minR2) return undefined;
  return { slope: reg.slope * 252, r2: reg.r2 };
}

// Simplified baseline: pick top 15 equal-weight (no ADV overflow complexity)
function allocateBaseline(
  data: EngineData,
  candidates: Candidate[],
  portfolioValue: number,
  dateStr: string,
): Allocation[] {
  const perSlot = portfolioValue / 15;
  const allocations: Allocation[] = [];
  const usedTradeIds = new Set<number>();

  for (let i = 0; i < candidates.length && allocations.length < 15; i++) {
    const c = candidates[i];
    const { adv, tradeId } = getEffectiveADV(
      data.pricesByInstrument,
      data.aToBMap,
      c.instrumentId,
      dateStr,
    );

    if (usedTradeIds.has(tradeId)) continue;
    if (usedTradeIds.has(c.instrumentId)) continue;
    const counterpartId =
      data.aToBMap.get(c.instrumentId) ?? data.bToAMap.get(c.instrumentId);
    if (counterpartId && usedTradeIds.has(counterpartId)) continue;

    // ADV check: reject if position > 10% of ADV (baseline uses reject, not cap)
    const maxByLiquidity = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
    if (perSlot > maxByLiquidity) continue;

    allocations.push({
      instrumentId: c.instrumentId,
      tradeId,
      slope: c.slope,
      r2: c.r2,
      pool: c.pool,
      allocation: perSlot,
      capped: false,
    });

    usedTradeIds.add(tradeId);
    usedTradeIds.add(c.instrumentId);
    if (counterpartId) usedTradeIds.add(counterpartId);
  }
  return allocations;
}

// Run a single strategy from a starting month index until reaching target or running out of data
function runStrategy(
  data: EngineData,
  startMonthIdx: number,
  mode: "dynamic" | "baseline",
  minR2: number = 0.6,
): {
  monthsToTarget: number | null;
  finalPV: number;
  maxDD: number;
  monthlyPVs: number[];
} {
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let totalContributed = INITIAL_CAPITAL;
  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyYear = 0;
  let peakPV = INITIAL_CAPITAL;
  let maxDD = 0;
  let monthsToTarget: number | null = null;
  const monthlyPVs: number[] = [];

  for (let mi = startMonthIdx; mi < data.monthEnds.length; mi++) {
    const day = data.monthEnds[mi];
    const currentYear = parseInt(day.slice(0, 4));
    const currentMonth = parseInt(day.slice(5, 7));

    // Monthly contribution
    if (mi > startMonthIdx) {
      cash += MONTHLY_CONTRIBUTION;
      totalContributed += MONTHLY_CONTRIBUTION;
    }

    // Qualify small caps
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

    // Portfolio value
    let currentPV = cash;
    for (const pos of positions) {
      const p =
        getPriceOnDate(data.pricesByInstrument, pos.tradeId, day) ||
        pos.entryPrice;
      currentPV += pos.shares * p;
    }

    // Drawdown
    if (currentPV > peakPV) peakPV = currentPV;
    const dd = (peakPV - currentPV) / peakPV;
    if (dd > maxDD) maxDD = dd;

    monthlyPVs.push(currentPV);

    // Check target
    if (monthsToTarget === null && currentPV >= TARGET) {
      monthsToTarget = mi - startMonthIdx;
    }

    // Allocate
    const allCandidates = getAllCandidatesWithR2(
      data,
      day,
      qualifiedSmallCaps,
      minR2,
    );
    const allocations =
      mode === "dynamic"
        ? allocatePositions(data, allCandidates, currentPV, day).allocations
        : allocateBaseline(data, allCandidates, currentPV, day);

    const allSelectedSignalIds = new Set(
      allocations.map((a) => a.instrumentId),
    );

    // Sell
    const keepPositions: Position[] = [];
    for (const pos of positions) {
      if (allSelectedSignalIds.has(pos.instrumentId)) {
        keepPositions.push(pos);
      } else {
        const price = getPriceOnDate(data.pricesByInstrument, pos.tradeId, day);
        if (price) cash += price * pos.shares;
      }
    }
    positions = keepPositions;

    // Rebalance + buy
    const allocationMap = new Map(allocations.map((a) => [a.instrumentId, a]));
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
        }
      } else if (currentValue < target * 0.99) {
        const buyShares = Math.floor((target - currentValue) / price);
        if (buyShares > 0 && cash >= buyShares * price) {
          cash -= buyShares * price;
          pos.shares += buyShares;
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
    }
  }

  // Final PV
  const lastDate = data.monthEnds[data.monthEnds.length - 1];
  let finalPV = cash;
  for (const pos of positions) {
    const price = getPriceOnDate(
      data.pricesByInstrument,
      pos.tradeId,
      lastDate,
    );
    finalPV += pos.shares * (price || pos.entryPrice);
  }

  return { monthsToTarget, finalPV, maxDD, monthlyPVs };
}

// Run index DCA from starting month
function runIndex(
  data: EngineData,
  startMonthIdx: number,
  benchId: number,
): { monthsToTarget: number | null; finalPV: number } {
  const startDate = data.monthEnds[startMonthIdx];
  const startPrice = getPriceOnDate(
    data.pricesByInstrument,
    benchId,
    startDate,
  );
  if (!startPrice) return { monthsToTarget: null, finalPV: 0 };

  let shares = INITIAL_CAPITAL / startPrice;
  let totalContributed = INITIAL_CAPITAL;
  let monthsToTarget: number | null = null;

  for (let mi = startMonthIdx + 1; mi < data.monthEnds.length; mi++) {
    const day = data.monthEnds[mi];
    const price = getPriceOnDate(data.pricesByInstrument, benchId, day);
    if (!price) continue;

    shares += MONTHLY_CONTRIBUTION / price;
    totalContributed += MONTHLY_CONTRIBUTION;

    const pv = shares * price;
    if (monthsToTarget === null && pv >= TARGET) {
      monthsToTarget = mi - startMonthIdx;
    }
  }

  const lastDate = data.monthEnds[data.monthEnds.length - 1];
  const lastPrice = getPriceOnDate(data.pricesByInstrument, benchId, lastDate);
  const finalPV = shares * (lastPrice || 0);

  return { monthsToTarget, finalPV };
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

  // ─── Fix: Load Spiltan prices into data (engine doesn't include it) ───
  const spiltanPrices = await prisma.stockPrice.findMany({
    where: { instrumentId: SPILTAN_ID },
    orderBy: { date: "asc" },
    select: {
      date: true,
      close: true,
      high: true,
      low: true,
      open: true,
      volume: true,
    },
  });
  if (spiltanPrices.length > 0) {
    data.pricesByInstrument.set(SPILTAN_ID, spiltanPrices as any);
    log(
      `Loaded ${spiltanPrices.length} Spiltan prices (${spiltanPrices[0].date.toISOString().slice(0, 10)} → ${spiltanPrices[spiltanPrices.length - 1].date.toISOString().slice(0, 10)})`,
    );
  } else {
    log("WARNING: No Spiltan price data found!");
  }

  log(`Loaded. ${data.monthEnds.length} month-ends available.`);

  // We want at least 60 months of runway for the race to be meaningful
  const maxStartIdx = data.monthEnds.length - 60;
  const cohortCount = Math.min(maxStartIdx, 156); // cap at 156 like original test

  log(`Running ${cohortCount} cohorts (each needing ≥60 months of data)...`);
  log("");

  type CohortResult = {
    startDate: string;
    dynamicMonths: number | null;
    dynamic07Months: number | null;
    dynamic08Months: number | null;
    baselineMonths: number | null;
    indexMonths: number | null;
    spiltanMonths: number | null;
    dynamicMaxDD: number;
    dynamic07MaxDD: number;
    dynamic08MaxDD: number;
    baselineMaxDD: number;
    dynamicWins: boolean; // dynamic reached 1M faster than baseline
  };

  const results: CohortResult[] = [];

  for (let ci = 0; ci < cohortCount; ci++) {
    if (ci % 10 === 0) process.stdout.write(`  Cohort ${ci}/${cohortCount}\r`);

    const dyn = runStrategy(data, ci, "dynamic", 0.6);
    const dyn07 = runStrategy(data, ci, "dynamic", 0.7);
    const dyn08 = runStrategy(data, ci, "dynamic", 0.8);
    const bas = runStrategy(data, ci, "baseline", 0.6);
    const idx = runIndex(data, ci, BENCHMARK_ID);
    const spi = runIndex(data, ci, SPILTAN_ID);

    results.push({
      startDate: data.monthEnds[ci],
      dynamicMonths: dyn.monthsToTarget,
      dynamic07Months: dyn07.monthsToTarget,
      dynamic08Months: dyn08.monthsToTarget,
      baselineMonths: bas.monthsToTarget,
      indexMonths: idx.monthsToTarget,
      spiltanMonths: spi.monthsToTarget,
      dynamicMaxDD: dyn.maxDD,
      dynamic07MaxDD: dyn07.maxDD,
      dynamic08MaxDD: dyn08.maxDD,
      baselineMaxDD: bas.maxDD,
      dynamicWins:
        dyn.monthsToTarget !== null &&
        (bas.monthsToTarget === null ||
          dyn.monthsToTarget < bas.monthsToTarget),
    });
  }
  process.stdout.write("\n");

  // ─── Analysis ──────────────────────────────────────────────────────────
  const dynReached = results.filter((r) => r.dynamicMonths !== null);
  const dyn07Reached = results.filter((r) => r.dynamic07Months !== null);
  const dyn08Reached = results.filter((r) => r.dynamic08Months !== null);
  const basReached = results.filter((r) => r.baselineMonths !== null);
  const idxReached = results.filter((r) => r.indexMonths !== null);
  const spiReached = results.filter((r) => r.spiltanMonths !== null);

  const dynMonths = dynReached
    .map((r) => r.dynamicMonths!)
    .sort((a, b) => a - b);
  const dyn07Months = dyn07Reached
    .map((r) => r.dynamic07Months!)
    .sort((a, b) => a - b);
  const dyn08Months = dyn08Reached
    .map((r) => r.dynamic08Months!)
    .sort((a, b) => a - b);
  const basMonths = basReached
    .map((r) => r.baselineMonths!)
    .sort((a, b) => a - b);
  const idxMonths = idxReached.map((r) => r.indexMonths!).sort((a, b) => a - b);
  const spiMonths = spiReached
    .map((r) => r.spiltanMonths!)
    .sort((a, b) => a - b);

  const dynDDs = results.map((r) => r.dynamicMaxDD * 100).sort((a, b) => a - b);
  const basDDs = results
    .map((r) => r.baselineMaxDD * 100)
    .sort((a, b) => a - b);

  log("═".repeat(90));
  log("RACE TO 1,000,000 SEK — FULL DISTRIBUTION");
  log("═".repeat(90));
  log(
    `Cohorts: ${cohortCount} (starting ${results[0].startDate} to ${results[results.length - 1].startDate})`,
  );
  log(
    `Target: ${TARGET.toLocaleString("sv-SE")} SEK | Initial: ${INITIAL_CAPITAL.toLocaleString("sv-SE")} + ${MONTHLY_CONTRIBUTION.toLocaleString("sv-SE")}/month`,
  );
  log("");

  log("─".repeat(110));
  log("MONTHS TO 1M:");
  log("─".repeat(110));
  log(
    `${"".padStart(20)} ${"Dyn R²≥0.6".padStart(12)} ${"Dyn R²≥0.7".padStart(12)} ${"Dyn R²≥0.8".padStart(12)} ${"Base(15)".padStart(10)} ${"OMXSPI".padStart(10)} ${"Spiltan".padStart(10)}`,
  );
  log("─".repeat(110));

  const fmtM = (months: number[], p: number) =>
    months.length > 0
      ? `${Math.round(percentile(months, p))} mo`.padStart(10)
      : "N/A".padStart(10);
  const fmtMean = (months: number[]) =>
    months.length > 0
      ? `${(months.reduce((s, v) => s + v, 0) / months.length).toFixed(1)} mo`.padStart(
          10,
        )
      : "N/A".padStart(10);

  log(
    `${"Reached target".padStart(20)} ${`${dynReached.length}/${cohortCount}`.padStart(12)} ${`${dyn07Reached.length}/${cohortCount}`.padStart(12)} ${`${dyn08Reached.length}/${cohortCount}`.padStart(12)} ${`${basReached.length}/${cohortCount}`.padStart(10)} ${`${idxReached.length}/${cohortCount}`.padStart(10)} ${`${spiReached.length}/${cohortCount}`.padStart(10)}`,
  );

  if (dynMonths.length > 0 && basMonths.length > 0) {
    const row = (label: string, p: number) =>
      log(
        `${label.padStart(20)} ${fmtM(dynMonths, p).padStart(12)} ${fmtM(dyn07Months, p).padStart(12)} ${fmtM(dyn08Months, p).padStart(12)} ${fmtM(basMonths, p).padStart(10)} ${fmtM(idxMonths, p).padStart(10)} ${fmtM(spiMonths, p).padStart(10)}`,
      );

    log(
      `${"Fastest (min)".padStart(20)} ${dynMonths.length > 0 ? `${dynMonths[0]} mo`.padStart(12) : "N/A".padStart(12)} ${dyn07Months.length > 0 ? `${dyn07Months[0]} mo`.padStart(12) : "N/A".padStart(12)} ${dyn08Months.length > 0 ? `${dyn08Months[0]} mo`.padStart(12) : "N/A".padStart(12)} ${basMonths.length > 0 ? `${basMonths[0]} mo`.padStart(10) : "N/A".padStart(10)} ${idxMonths.length > 0 ? `${idxMonths[0]} mo`.padStart(10) : "N/A".padStart(10)} ${spiMonths.length > 0 ? `${spiMonths[0]} mo`.padStart(10) : "N/A".padStart(10)}`,
    );
    row("10th percentile", 10);
    row("25th percentile", 25);
    row("Median", 50);
    log(
      `${"Mean".padStart(20)} ${fmtMean(dynMonths).padStart(12)} ${fmtMean(dyn07Months).padStart(12)} ${fmtMean(dyn08Months).padStart(12)} ${fmtMean(basMonths).padStart(10)} ${fmtMean(idxMonths).padStart(10)} ${fmtMean(spiMonths).padStart(10)}`,
    );
    row("75th percentile", 75);
    row("90th percentile", 90);
    log(
      `${"Slowest (max)".padStart(20)} ${dynMonths.length > 0 ? `${dynMonths[dynMonths.length - 1]} mo`.padStart(12) : "N/A".padStart(12)} ${dyn07Months.length > 0 ? `${dyn07Months[dyn07Months.length - 1]} mo`.padStart(12) : "N/A".padStart(12)} ${dyn08Months.length > 0 ? `${dyn08Months[dyn08Months.length - 1]} mo`.padStart(12) : "N/A".padStart(12)} ${basMonths.length > 0 ? `${basMonths[basMonths.length - 1]} mo`.padStart(10) : "N/A".padStart(10)} ${idxMonths.length > 0 ? `${idxMonths[idxMonths.length - 1]} mo`.padStart(10) : "N/A".padStart(10)} ${spiMonths.length > 0 ? `${spiMonths[spiMonths.length - 1]} mo`.padStart(10) : "N/A".padStart(10)}`,
    );
  }

  // ─── Head-to-head comparison ───────────────────────────────────────────
  log("");
  log("─".repeat(90));
  log("HEAD-TO-HEAD: DYNAMIC vs BASELINE");
  log("─".repeat(90));

  const dynWins = results.filter((r) => r.dynamicWins).length;
  const basWins = results.filter(
    (r) =>
      r.baselineMonths !== null &&
      (r.dynamicMonths === null || r.baselineMonths < r.dynamicMonths),
  ).length;
  const ties = results.filter(
    (r) => r.dynamicMonths !== null && r.dynamicMonths === r.baselineMonths,
  ).length;

  log(
    `  Dynamic wins:   ${dynWins}/${cohortCount} (${((dynWins / cohortCount) * 100).toFixed(1)}%)`,
  );
  log(
    `  Baseline wins:  ${basWins}/${cohortCount} (${((basWins / cohortCount) * 100).toFixed(1)}%)`,
  );
  log(`  Ties:           ${ties}/${cohortCount}`);

  // When dynamic wins, by how much? When it loses, by how much?
  const dynAdvantage: number[] = [];
  const dynDisadvantage: number[] = [];
  for (const r of results) {
    if (r.dynamicMonths !== null && r.baselineMonths !== null) {
      const diff = r.baselineMonths - r.dynamicMonths; // positive = dynamic faster
      if (diff > 0) dynAdvantage.push(diff);
      else if (diff < 0) dynDisadvantage.push(-diff);
    }
  }

  if (dynAdvantage.length > 0) {
    dynAdvantage.sort((a, b) => a - b);
    log(
      `  When dynamic wins: avg ${(dynAdvantage.reduce((s, v) => s + v, 0) / dynAdvantage.length).toFixed(1)} months faster`,
    );
    log(
      `    Median advantage: ${Math.round(percentile(dynAdvantage, 50))} months`,
    );
    log(
      `    Max advantage:    ${dynAdvantage[dynAdvantage.length - 1]} months`,
    );
  }
  if (dynDisadvantage.length > 0) {
    dynDisadvantage.sort((a, b) => a - b);
    log(
      `  When baseline wins: avg ${(dynDisadvantage.reduce((s, v) => s + v, 0) / dynDisadvantage.length).toFixed(1)} months faster`,
    );
    log(
      `    Median disadvantage: ${Math.round(percentile(dynDisadvantage, 50))} months`,
    );
    log(
      `    Max disadvantage:    ${dynDisadvantage[dynDisadvantage.length - 1]} months`,
    );
  }

  // ─── Drawdown comparison ───────────────────────────────────────────────
  log("");
  log("─".repeat(90));
  log("MAX DRAWDOWN ON THE PATH TO 1M:");
  log("─".repeat(90));
  log(
    `${"".padStart(20)} ${"Dynamic(3)".padStart(12)} ${"Baseline(15)".padStart(13)}`,
  );
  log("─".repeat(90));
  log(
    `${"Median max DD".padStart(20)} ${`${percentile(dynDDs, 50).toFixed(1)}%`.padStart(12)} ${`${percentile(basDDs, 50).toFixed(1)}%`.padStart(13)}`,
  );
  log(
    `${"75th pctile DD".padStart(20)} ${`${percentile(dynDDs, 75).toFixed(1)}%`.padStart(12)} ${`${percentile(basDDs, 75).toFixed(1)}%`.padStart(13)}`,
  );
  log(
    `${"90th pctile DD".padStart(20)} ${`${percentile(dynDDs, 90).toFixed(1)}%`.padStart(12)} ${`${percentile(basDDs, 90).toFixed(1)}%`.padStart(13)}`,
  );
  log(
    `${"Worst DD".padStart(20)} ${`${dynDDs[dynDDs.length - 1].toFixed(1)}%`.padStart(12)} ${`${basDDs[basDDs.length - 1].toFixed(1)}%`.padStart(13)}`,
  );

  // ─── Risk-adjusted speed ──────────────────────────────────────────────
  log("");
  log("─".repeat(90));
  log("THE TRADE-OFF: SPEED vs PAIN");
  log("─".repeat(90));
  log("");
  log(
    "  For each cohort, compute: months_saved = baseline_months - dynamic_months",
  );
  log("  And: extra_drawdown = dynamic_maxDD - baseline_maxDD");
  log("");

  const tradeoffs: {
    monthsSaved: number;
    extraDD: number;
    startDate: string;
  }[] = [];
  for (const r of results) {
    if (r.dynamicMonths !== null && r.baselineMonths !== null) {
      tradeoffs.push({
        monthsSaved: r.baselineMonths - r.dynamicMonths,
        extraDD: (r.dynamicMaxDD - r.baselineMaxDD) * 100,
        startDate: r.startDate,
      });
    }
  }

  if (tradeoffs.length > 0) {
    const avgSaved =
      tradeoffs.reduce((s, t) => s + t.monthsSaved, 0) / tradeoffs.length;
    const avgExtraDD =
      tradeoffs.reduce((s, t) => s + t.extraDD, 0) / tradeoffs.length;
    const positiveSaved = tradeoffs.filter((t) => t.monthsSaved > 0);
    const negativeSaved = tradeoffs.filter((t) => t.monthsSaved < 0);

    log(`  Average months saved by dynamic: ${avgSaved.toFixed(1)}`);
    log(
      `  Average extra drawdown:          ${avgExtraDD.toFixed(1)} percentage points`,
    );
    log(
      `  "Price" per month saved:         ${(avgExtraDD / Math.max(avgSaved, 0.1)).toFixed(1)}pp drawdown per month of speed`,
    );
    log("");
    log(
      `  Cohorts where dynamic is FASTER and has LESS drawdown: ${tradeoffs.filter((t) => t.monthsSaved > 0 && t.extraDD <= 0).length}/${tradeoffs.length}`,
    );
    log(
      `  Cohorts where dynamic is FASTER but has MORE drawdown: ${tradeoffs.filter((t) => t.monthsSaved > 0 && t.extraDD > 0).length}/${tradeoffs.length}`,
    );
    log(
      `  Cohorts where dynamic is SLOWER:                       ${negativeSaved.length}/${tradeoffs.length}`,
    );

    // Worst cases for dynamic
    const worstCohorts = [...tradeoffs]
      .filter((t) => t.monthsSaved < 0)
      .sort((a, b) => a.monthsSaved - b.monthsSaved)
      .slice(0, 5);

    if (worstCohorts.length > 0) {
      log("");
      log("  WORST COHORTS FOR DYNAMIC (baseline was faster):");
      for (const wc of worstCohorts) {
        log(
          `    Started ${wc.startDate}: baseline ${-wc.monthsSaved} months faster, dynamic had ${wc.extraDD.toFixed(1)}pp extra DD`,
        );
      }
    }

    // Best cases for dynamic
    const bestCohorts = [...tradeoffs]
      .sort((a, b) => b.monthsSaved - a.monthsSaved)
      .slice(0, 5);

    log("");
    log("  BEST COHORTS FOR DYNAMIC:");
    for (const bc of bestCohorts) {
      log(
        `    Started ${bc.startDate}: dynamic ${bc.monthsSaved} months faster, ${bc.extraDD > 0 ? `${bc.extraDD.toFixed(1)}pp extra DD` : `${(-bc.extraDD).toFixed(1)}pp LESS DD`}`,
      );
    }
  }

  log("");
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`\nOutput: ${OUTPUT_FILE}`);
  await disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
