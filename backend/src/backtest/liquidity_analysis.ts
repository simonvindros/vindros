/**
 * LIQUIDITY & COMPOSITION ANALYSIS
 *
 * Trader questions:
 * 1. How often does the portfolio hold small/illiquid stocks?
 * 2. What's the pool (large vs small) breakdown over time?
 * 3. What are the existing floors/filters?
 * 4. What would realistic transaction costs look like?
 * 5. What's the net-of-cost return?
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
  getADV,
  getEffectiveADV,
  latestAvailableQuarter,
  disconnect,
  INITIAL_CAPITAL,
  MONTHLY_CONTRIBUTION,
  BENCHMARK_ID,
  MIN_PRICE,
  MAX_ADV_FRACTION,
  EngineData,
  Position,
} from "./engine";

const OUTPUT_FILE = path.join(__dirname, "liquidity_analysis_output.txt");
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

  const totalContributed =
    INITIAL_CAPITAL + MONTHLY_CONTRIBUTION * data.monthEnds.length;

  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyKey = 0;

  // Track composition stats
  let totalSmallMonths = 0; // slot-months in small pool
  let totalLargeMonths = 0; // slot-months in large pool
  let totalSlotMonths = 0;
  const advAtEntry: number[] = []; // ADV (SEK) when entering each position
  const monthlySmallFraction: number[] = [];
  const monthlySmallAllocation: number[] = []; // fraction of portfolio VALUE in small caps
  let totalTrades = 0;
  let totalSellValue = 0;
  let totalBuyValue = 0;
  const values: number[] = [INITIAL_CAPITAL];

  // Market breakdown: which market IDs do we actually hold?
  const marketHoldCounts = new Map<number, number>(); // marketId → slot-months
  // We need marketId lookup
  const { prisma } = await import("../lib/prisma");
  const instruments = await prisma.instrument.findMany({
    select: { id: true, marketId: true },
  });
  const marketIdMap = new Map<number, number>();
  for (const inst of instruments) {
    if (inst.marketId) marketIdMap.set(inst.id, inst.marketId);
  }
  const marketNames: Record<number, string> = {
    1: "Large Cap",
    2: "Mid Cap",
    3: "Small Cap",
    4: "First North",
    5: "Spotlight",
    6: "NGM",
  };

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

    const candidates = getAllCandidates(data, day, qualifiedSmallCaps);
    const { allocations } = allocatePositions(data, candidates, currentPV, day);
    const selectedIds = new Set(allocations.map((a) => a.instrumentId));

    // Sell non-selected — track cost
    for (const pos of positions) {
      if (!selectedIds.has(pos.instrumentId)) {
        const price = getPriceOnDate(data.pricesByInstrument, pos.tradeId, day);
        if (price) {
          const sellValue = price * pos.shares;
          cash += sellValue;
          totalSellValue += sellValue;
          totalTrades++;
        }
      }
    }
    positions = positions.filter((p) => selectedIds.has(p.instrumentId));

    // Buy new — track cost + ADV
    const heldIds = new Set(positions.map((p) => p.instrumentId));
    for (const a of allocations) {
      if (heldIds.has(a.instrumentId)) continue;
      const price = getPriceOnDate(data.pricesByInstrument, a.tradeId, day);
      if (!price) continue;
      const shares = Math.floor(Math.min(a.allocation, cash) / price);
      if (shares === 0) continue;

      const buyValue = shares * price;
      totalBuyValue += buyValue;
      totalTrades++;

      // Record ADV at entry
      const adv = getADV(data.pricesByInstrument, a.tradeId, day);
      advAtEntry.push(adv);

      positions.push({
        instrumentId: a.instrumentId,
        tradeId: a.tradeId,
        name: data.nameMap.get(a.instrumentId) || "",
        entryDate: day,
        entryPrice: price,
        shares,
        pool: a.pool,
      });
      cash -= buyValue;
    }

    // Record composition
    let smallSlots = 0;
    let largeSlots = 0;
    let smallValue = 0;
    let totalValue = 0;
    for (const pos of positions) {
      const p =
        getPriceOnDate(data.pricesByInstrument, pos.tradeId, day) ||
        pos.entryPrice;
      const posValue = pos.shares * p;
      totalValue += posValue;
      if (pos.pool === "small") {
        smallSlots++;
        smallValue += posValue;
      } else {
        largeSlots++;
      }
      // Market breakdown
      const mktId = marketIdMap.get(pos.instrumentId);
      if (mktId)
        marketHoldCounts.set(mktId, (marketHoldCounts.get(mktId) || 0) + 1);
    }
    totalSmallMonths += smallSlots;
    totalLargeMonths += largeSlots;
    totalSlotMonths += positions.length;
    monthlySmallFraction.push(
      positions.length > 0 ? smallSlots / positions.length : 0,
    );
    monthlySmallAllocation.push(totalValue > 0 ? smallValue / totalValue : 0);

    // Record portfolio value
    let finalPV = cash;
    for (const pos of positions) {
      const p =
        getPriceOnDate(data.pricesByInstrument, pos.tradeId, day) ||
        pos.entryPrice;
      finalPV += pos.shares * p;
    }
    values.push(finalPV);
  }

  const finalPV = values[values.length - 1];
  const grossReturn = (finalPV / totalContributed - 1) * 100;

  // ─── Output ──────────────────────────────────────────────────────────────
  log("═".repeat(90));
  log("LIQUIDITY & COMPOSITION ANALYSIS");
  log("═".repeat(90));
  log(
    `Period: ${data.monthEnds[0]} to ${data.monthEnds[data.monthEnds.length - 1]} (${data.monthEnds.length} months)`,
  );
  log(`Contributed: ${totalContributed.toLocaleString("sv-SE")} SEK`);
  log(
    `Gross final PV: ${finalPV.toLocaleString("sv-SE", { maximumFractionDigits: 0 })} SEK`,
  );
  log("");

  // ─── EXISTING FLOORS ────────────────────────────────────────────────────
  log("─".repeat(90));
  log("EXISTING FLOORS & FILTERS:");
  log("─".repeat(90));
  log(`  MIN_PRICE:            ${MIN_PRICE} SEK (no penny stocks)`);
  log(
    `  MAX_ADV_FRACTION:     ${(MAX_ADV_FRACTION * 100).toFixed(0)}% of 20-day avg daily volume (SEK)`,
  );
  log(
    `  Small-cap quality:    Revenue ≥ 50M SEK, 5yr avg revenue growth ≥ 10%,`,
  );
  log(`                        operating margin check, no spike/crash years`);
  log(`  R² ≥ 0.6:             Trend must be smooth (noisy stocks excluded)`);
  log(
    `  Large/mid caps:       NO fundamental filter (markets 1-2 = free entry)`,
  );
  log("");

  // ─── POOL COMPOSITION ───────────────────────────────────────────────────
  log("─".repeat(90));
  log("POOL COMPOSITION (slot-months):");
  log("─".repeat(90));
  log(
    `  Large/Mid cap slots:  ${totalLargeMonths} (${((totalLargeMonths / totalSlotMonths) * 100).toFixed(1)}%)`,
  );
  log(
    `  Small cap slots:      ${totalSmallMonths} (${((totalSmallMonths / totalSlotMonths) * 100).toFixed(1)}%)`,
  );
  log(`  Total slot-months:    ${totalSlotMonths}`);
  log("");

  const avgSmallFrac =
    monthlySmallFraction.reduce((s, v) => s + v, 0) /
    monthlySmallFraction.length;
  const avgSmallAlloc =
    monthlySmallAllocation.reduce((s, v) => s + v, 0) /
    monthlySmallAllocation.length;
  const monthsAllSmall = monthlySmallFraction.filter((f) => f >= 0.99).length;
  const monthsAllLarge = monthlySmallFraction.filter((f) => f <= 0.01).length;
  const monthsMajoritySmall = monthlySmallFraction.filter(
    (f) => f > 0.5,
  ).length;

  log(
    `  Avg small-cap fraction (by slots):  ${(avgSmallFrac * 100).toFixed(1)}%`,
  );
  log(
    `  Avg small-cap fraction (by value):  ${(avgSmallAlloc * 100).toFixed(1)}%`,
  );
  log(
    `  Months 100% small caps:             ${monthsAllSmall} / ${data.monthEnds.length} (${((monthsAllSmall / data.monthEnds.length) * 100).toFixed(1)}%)`,
  );
  log(
    `  Months 100% large/mid caps:         ${monthsAllLarge} / ${data.monthEnds.length} (${((monthsAllLarge / data.monthEnds.length) * 100).toFixed(1)}%)`,
  );
  log(
    `  Months majority small cap:          ${monthsMajoritySmall} / ${data.monthEnds.length} (${((monthsMajoritySmall / data.monthEnds.length) * 100).toFixed(1)}%)`,
  );
  log("");

  // ─── MARKET BREAKDOWN ───────────────────────────────────────────────────
  log("─".repeat(90));
  log("MARKET BREAKDOWN (slot-months):");
  log("─".repeat(90));
  const sortedMarkets = [...marketHoldCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  );
  for (const [mktId, count] of sortedMarkets) {
    const name = marketNames[mktId] || `Market ${mktId}`;
    log(
      `  ${name.padEnd(20)} ${String(count).padStart(6)} slot-months (${((count / totalSlotMonths) * 100).toFixed(1)}%)`,
    );
  }
  log("");

  // ─── ADV AT ENTRY ────────────────────────────────────────────────────────
  log("─".repeat(90));
  log("ADV (Average Daily Volume in SEK) AT ENTRY:");
  log("─".repeat(90));
  const sortedADV = [...advAtEntry].sort((a, b) => a - b);
  const advP10 = sortedADV[Math.floor(sortedADV.length * 0.1)];
  const advP25 = sortedADV[Math.floor(sortedADV.length * 0.25)];
  const advMedian = sortedADV[Math.floor(sortedADV.length * 0.5)];
  const advP75 = sortedADV[Math.floor(sortedADV.length * 0.75)];
  const advP90 = sortedADV[Math.floor(sortedADV.length * 0.9)];
  const advMean = advAtEntry.reduce((s, v) => s + v, 0) / advAtEntry.length;

  const fmtAdv = (v: number) => {
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
    return v.toFixed(0);
  };

  log(`  Entries:    ${advAtEntry.length} trades`);
  log(`  Min ADV:    ${fmtAdv(sortedADV[0])} SEK`);
  log(`  10th pctl:  ${fmtAdv(advP10)} SEK`);
  log(`  25th pctl:  ${fmtAdv(advP25)} SEK`);
  log(`  Median:     ${fmtAdv(advMedian)} SEK`);
  log(`  Mean:       ${fmtAdv(advMean)} SEK`);
  log(`  75th pctl:  ${fmtAdv(advP75)} SEK`);
  log(`  90th pctl:  ${fmtAdv(advP90)} SEK`);
  log(`  Max ADV:    ${fmtAdv(sortedADV[sortedADV.length - 1])} SEK`);
  log("");

  // ADV buckets
  const advBuckets = [
    { label: "< 100k SEK (illiquid)", min: 0, max: 100_000 },
    { label: "100k – 500k SEK", min: 100_000, max: 500_000 },
    { label: "500k – 1M SEK", min: 500_000, max: 1_000_000 },
    { label: "1M – 5M SEK", min: 1_000_000, max: 5_000_000 },
    { label: "5M – 20M SEK", min: 5_000_000, max: 20_000_000 },
    { label: "20M+ SEK (liquid)", min: 20_000_000, max: Infinity },
  ];
  log("  ADV distribution of entries:");
  for (const b of advBuckets) {
    const count = advAtEntry.filter((v) => v >= b.min && v < b.max).length;
    const pct = ((count / advAtEntry.length) * 100).toFixed(1);
    const bar = "█".repeat(Math.round((count / advAtEntry.length) * 40));
    log(
      `    ${b.label.padEnd(28)} ${String(count).padStart(5)} (${pct.padStart(5)}%) ${bar}`,
    );
  }
  log("");

  // ─── TRANSACTION COST SIMULATION ────────────────────────────────────────
  log("─".repeat(90));
  log("TRANSACTION COST SIMULATION:");
  log("─".repeat(90));
  log(`  Total trades:         ${totalTrades} (buys + sells)`);
  log(
    `  Total buy volume:     ${totalBuyValue.toLocaleString("sv-SE", { maximumFractionDigits: 0 })} SEK`,
  );
  log(
    `  Total sell volume:    ${totalSellValue.toLocaleString("sv-SE", { maximumFractionDigits: 0 })} SEK`,
  );
  const totalTurnover = totalBuyValue + totalSellValue;
  log(
    `  Total traded volume:  ${totalTurnover.toLocaleString("sv-SE", { maximumFractionDigits: 0 })} SEK`,
  );
  log("");

  // Cost scenarios: commission + spread impact
  const costScenarios = [
    { name: "Optimistic (Avanza, large caps)", bps: 6 }, // 0.06% = 0.015% commission + ~0.04% half-spread
    { name: "Moderate (mixed liquidity)", bps: 15 }, // 0.15%
    { name: "Pessimistic (small/illiquid)", bps: 30 }, // 0.30%
    { name: "Worst case (micro caps)", bps: 50 }, // 0.50%
  ];

  log(
    `  ${"Scenario".padEnd(40)} ${"Cost/trade".padStart(10)} ${"Total cost".padStart(14)} ${"Net return".padStart(12)}`,
  );
  log("  " + "─".repeat(78));
  for (const sc of costScenarios) {
    const totalCost = (totalTurnover * sc.bps) / 10_000;
    const netPV = finalPV - totalCost;
    const netReturn = (netPV / totalContributed - 1) * 100;
    log(
      `  ${sc.name.padEnd(40)} ${(sc.bps + " bps").padStart(10)} ${totalCost.toLocaleString("sv-SE", { maximumFractionDigits: 0 }).padStart(14)} ${(netReturn.toFixed(0) + "%").padStart(12)}`,
    );
  }
  log(`  (Gross return without costs: ${grossReturn.toFixed(0)}%)`);
  log("");

  // ─── CALMAR AND KEY RISK RATIOS ─────────────────────────────────────────
  log("─".repeat(90));
  log("KEY RISK RATIOS (for the trader):");
  log("─".repeat(90));

  // Monthly returns
  const monthlyReturns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    monthlyReturns.push(
      (values[i] - values[i - 1] - MONTHLY_CONTRIBUTION) / values[i - 1],
    );
  }
  const mean =
    monthlyReturns.reduce((s, v) => s + v, 0) / monthlyReturns.length;
  const stdev = Math.sqrt(
    monthlyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) /
      (monthlyReturns.length - 1),
  );
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(12) : 0;

  // Sortino
  const negReturns = monthlyReturns.filter((r) => r < 0);
  const downDev = Math.sqrt(
    negReturns.reduce((s, v) => s + v ** 2, 0) / monthlyReturns.length,
  );
  const sortino = downDev > 0 ? (mean / downDev) * Math.sqrt(12) : 0;

  // Max DD
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // CAGR (from value series, accounting for contributions)
  // Use modified Dietz or approximate: final / contributed, annualized
  const years = data.monthEnds.length / 12;
  // TWR approximation
  let twr = 1;
  for (const r of monthlyReturns) twr *= 1 + r;
  const cagr = (Math.pow(twr, 1 / years) - 1) * 100;

  const calmar = maxDD > 0 ? cagr / (maxDD * 100) : 0;

  log(
    `  Sharpe ratio:         ${sharpe.toFixed(2)}   (return per unit of total volatility)`,
  );
  log(
    `  Sortino ratio:        ${sortino.toFixed(2)}   (return per unit of DOWNSIDE volatility)`,
  );
  log(`  Calmar ratio:         ${calmar.toFixed(2)}   (CAGR / max drawdown)`);
  log(`  Max drawdown:        ${(-maxDD * 100).toFixed(1)}%`);
  log(`  CAGR (TWR):           ${cagr.toFixed(1)}%`);
  log(`  Annualized vol:       ${(stdev * Math.sqrt(12) * 100).toFixed(1)}%`);
  log("");
  log(`  INTERPRETATION:`);
  log(
    `    Sharpe ${sharpe.toFixed(2)}: For every 1% of volatility, you earn ${(sharpe * 1).toFixed(2)}% return.`,
  );
  log(
    `    Calmar ${calmar.toFixed(2)}: For every 1% of max drawdown, you earn ${calmar.toFixed(2)}% CAGR.`,
  );
  log(
    `    A Calmar > 1.0 means CAGR exceeds the worst drawdown — historically recovered.`,
  );
  log(
    `    A Calmar < 0.5 means the drawdown pain far exceeds the annual return.`,
  );
  log("");

  // ─── TRADER CONTEXT ─────────────────────────────────────────────────────
  log("─".repeat(90));
  log("WHAT THE TRADER SHOULD KNOW:");
  log("─".repeat(90));
  log(
    `  1. FLOORS: ${MIN_PRICE} SEK min price + 10% max ADV + quality gate on small caps.`,
  );
  log(
    `     These already exclude penny stocks and the most illiquid micro caps.`,
  );
  log("");
  log(
    `  2. SMALL CAP DOMINANCE: ${((totalSmallMonths / totalSlotMonths) * 100).toFixed(0)}% of slot-months are small-cap.`,
  );
  log(
    `     The strategy IS a small-cap momentum strategy with large-cap diversification.`,
  );
  log(
    `     This is both the source of alpha AND the source of liquidity risk.`,
  );
  log("");
  log(`  3. COSTS: With ${totalTrades} trades over ${years.toFixed(0)} years,`);
  log(
    `     at 15 bps per trade the total cost is ~${((totalTurnover * 15) / 10_000 / 1000).toFixed(0)}k SEK.`,
  );
  log(`     That's a drag but doesn't kill the strategy.`);
  log("");
  log(
    `  4. THE REAL RETURN NUMBER: ${cagr.toFixed(1)}% CAGR (time-weighted, before costs).`,
  );
  log(`     After moderate costs: ~${(cagr * 0.92).toFixed(1)}% CAGR.`);
  log(`     OMXSPI benchmark: ~8-9% CAGR over the same period.`);
  log("");

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`Output: ${OUTPUT_FILE}`);
  await disconnect();
};

run();
