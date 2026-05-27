/**
 * VINDROS UNIFIED — Split Slots
 *
 * 10 positions from Large/Mid Cap (ranked by slope)
 * 5 positions from fundamental-filtered Small/FN/Spotlight (ranked by slope)
 * Each pool has reserved slots — small caps can't be crowded out
 *
 * Same YOLO+ momentum logic within each pool
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

const OUTPUT_FILE = path.join(__dirname, "vindros_final_output.txt");
const lines: string[] = [];
const log = (msg = "") => { lines.push(msg); console.log(msg); };

// ─── Configuration ───────────────────────────────────────────────────────────
const START_DATE = new Date("2018-01-01");
const END_DATE = new Date("2026-05-22");
const LARGE_MID_SLOTS = 10;
const SMALL_SLOTS = 5;
const TOTAL_POSITIONS = LARGE_MID_SLOTS + SMALL_SLOTS;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const BENCHMARK_ID = 638;
const REG_SHORT = 90;
const MIN_PRICE = 10;
const SALARY_DAY = 23;

// Markets
const LARGE_MID_MARKETS = [1, 2];
const SMALL_MARKETS = [3, 4, 5];

// Fundamental thresholds
const MIN_REVENUE_GROWTH = 15;
const MIN_REVENUE_MSEK = 50;
const MIN_OPERATING_MARGIN = 5;
const MIN_YEARS_DATA = 4;
const KPI_REVENUE_GROWTH = 94;
const KPI_OPERATING_MARGIN = 29;
const KPI_REVENUE = 53;

// ─── Types ───────────────────────────────────────────────────────────────────
type PriceRow = { date: Date; close: number };
type Position = { instrumentId: number; name: string; entryDate: string; entryPrice: number; shares: number; pool: "large" | "small" };
type ClosedTrade = { instrumentId: number; name: string; entryDate: string; exitDate: string; holdDays: number; entryPrice: number; exitPrice: number; shares: number; pnl: number; returnPct: number; pool: "large" | "small" };

// ─── Quarterly Helper ────────────────────────────────────────────────────────
function latestAvailableQuarter(dateStr: string): { year: number; period: number } {
  const month = Number.parseInt(dateStr.slice(5, 7));
  const year = Number.parseInt(dateStr.slice(0, 4));
  const currentQ = Math.ceil(month / 3);
  // 1 quarter reporting lag
  if (currentQ === 1) return { year: year - 1, period: 4 };
  return { year, period: currentQ - 1 };
}

// ─── Fundamental Filter (Annual baseline + Quarterly freshness check) ────────
async function getQualifiedSmallCaps(instrumentIds: number[], asOfYear: number, asOfQuarterYear: number, asOfPeriod: number): Promise<Set<number>> {
  // 1) Annual baseline qualification
  const annualKpis = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: instrumentIds },
      kpiId: { in: [KPI_REVENUE_GROWTH, KPI_OPERATING_MARGIN, KPI_REVENUE] },
      reportType: "year",
      priceType: "mean",
    },
    select: { instrumentId: true, kpiId: true, year: true, value: true },
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }],
  });

  const data = new Map<number, Map<number, Map<number, number>>>();
  for (const kv of annualKpis) {
    if (kv.value === null) continue;
    if (!data.has(kv.instrumentId)) data.set(kv.instrumentId, new Map());
    const instMap = data.get(kv.instrumentId)!;
    if (!instMap.has(kv.kpiId)) instMap.set(kv.kpiId, new Map());
    instMap.get(kv.kpiId)!.set(kv.year, Number(kv.value));
  }

  const annualQualified = new Set<number>();

  for (const [instId, kpiMap] of data) {
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
      const latest = [...revenueMap.entries()].filter(([y]) => y <= asOfYear).sort((a, b) => a[0] - b[0]).pop();
      if (latest && latest[1] < MIN_REVENUE_MSEK) continue;
    }

    const opMarginMap = kpiMap.get(KPI_OPERATING_MARGIN);
    if (!opMarginMap) continue;
    const opMargins = [...opMarginMap.entries()].filter(([y]) => y <= asOfYear).sort((a, b) => a[0] - b[0]);
    if (opMargins.length < MIN_YEARS_DATA) continue;
    const latestMargin = opMargins[opMargins.length - 1][1];
    if (latestMargin < MIN_OPERATING_MARGIN) continue;
    const olderMargin = opMargins[Math.max(0, opMargins.length - 4)][1];
    if (latestMargin - olderMargin < 0) continue;

    annualQualified.add(instId);
  }

  // 2) Quarterly freshness check: disqualify if latest quarter deteriorates
  const quarterlyKpis = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: [...annualQualified] },
      kpiId: { in: [KPI_REVENUE_GROWTH, KPI_OPERATING_MARGIN] },
      reportType: "quarter",
      priceType: "mean",
    },
    select: { instrumentId: true, kpiId: true, year: true, period: true, value: true },
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }, { period: "asc" }],
  });

  const cutoff = asOfQuarterYear * 10 + asOfPeriod;
  const qData = new Map<number, Map<number, Array<{ key: number; value: number }>>>();
  for (const kv of quarterlyKpis) {
    if (kv.value === null) continue;
    const key = kv.year * 10 + (kv.period ?? 0);
    if (key > cutoff) continue;
    if (!qData.has(kv.instrumentId)) qData.set(kv.instrumentId, new Map());
    const instMap = qData.get(kv.instrumentId)!;
    if (!instMap.has(kv.kpiId)) instMap.set(kv.kpiId, []);
    instMap.get(kv.kpiId)!.push({ key, value: Number(kv.value) });
  }

  const qualified = new Set<number>();

  for (const instId of annualQualified) {
    const instQ = qData.get(instId);

    // If no quarterly data available yet, pass on annual alone
    if (!instQ) {
      qualified.add(instId);
      continue;
    }

    // Freshness check 1: latest quarter revenue growth must not be deeply negative
    const revQ = instQ.get(KPI_REVENUE_GROWTH);
    if (revQ && revQ.length > 0) {
      revQ.sort((a, b) => a.key - b.key);
      const latestRevGrowth = revQ[revQ.length - 1].value;
      if (latestRevGrowth < -10) continue;
    }

    // Freshness check 2: latest quarter operating margin must not be negative
    const margQ = instQ.get(KPI_OPERATING_MARGIN);
    if (margQ && margQ.length > 0) {
      margQ.sort((a, b) => a.key - b.key);
      const latestMargin = margQ[margQ.length - 1].value;
      if (latestMargin < 0) continue;
    }

    qualified.add(instId);
  }

  return qualified;
}

// ─── Main ────────────────────────────────────────────────────────────────────
const run = async () => {
  const largeMidInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: LARGE_MID_MARKETS }, countryId: 1 },
    select: { id: true, name: true },
  });
  const smallInstruments = await prisma.instrument.findMany({
    where: { marketId: { in: SMALL_MARKETS }, countryId: 1 },
    select: { id: true, name: true },
  });

  const allInstruments = [...largeMidInstruments, ...smallInstruments];
  const allIds = allInstruments.map((i) => i.id);
  const nameMap = new Map<number, string>(allInstruments.map((i) => [i.id, i.name]));
  const smallIds = smallInstruments.map((i) => i.id);
  const largeMidIdSet = new Set(largeMidInstruments.map((i) => i.id));

  log(`Large/Mid Cap: ${largeMidInstruments.length} (${LARGE_MID_SLOTS} slots)`);
  log(`Small/FN/Spotlight: ${smallInstruments.length} (${SMALL_SLOTS} slots, filtered)`);

  // Load prices
  const warmupDate = new Date(START_DATE);
  warmupDate.setDate(warmupDate.getDate() - 150);

  const allPrices = await prisma.stockPrice.findMany({
    where: {
      instrumentId: { in: [...allIds, BENCHMARK_ID] },
      date: { gte: warmupDate, lte: END_DATE },
    },
    select: { instrumentId: true, date: true, close: true },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  });

  const pricesByInstrument = new Map<number, PriceRow[]>();
  for (const p of allPrices) {
    if (!pricesByInstrument.has(p.instrumentId)) pricesByInstrument.set(p.instrumentId, []);
    pricesByInstrument.get(p.instrumentId)!.push({ date: p.date, close: Number(p.close) });
  }

  log(`Loaded ${allPrices.length} price rows.\n`);

  // Trading days
  const benchPrices = pricesByInstrument.get(BENCHMARK_ID) || [];
  const tradingDates = benchPrices
    .filter((p) => p.date >= START_DATE && p.date <= END_DATE)
    .map((p) => p.date.toISOString().slice(0, 10));

  // Rebalance = last trading day of month
  const rebalanceDates: string[] = [];
  for (let i = 0; i < tradingDates.length - 1; i++) {
    if (tradingDates[i].slice(0, 7) !== tradingDates[i + 1].slice(0, 7))
      rebalanceDates.push(tradingDates[i]);
  }
  if (tradingDates.length > 0) rebalanceDates.push(tradingDates[tradingDates.length - 1]);
  const rebalanceSet = new Set(rebalanceDates);

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
    for (const d of days) { if (d <= cutoff) salaryDate = d; }
    salaryDates.add(salaryDate);
  }

  // Helpers
  const getPriceOnDate = (instId: number, dateStr: string): number | undefined => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return undefined;
    let lo = 0, hi = prices.length - 1, best: number | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prices[mid].date.toISOString().slice(0, 10) <= dateStr) { best = prices[mid].close; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return best;
  };

  const getPriceIndex = (instId: number, dateStr: string): number => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return -1;
    let lo = 0, hi = prices.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prices[mid].date.toISOString().slice(0, 10) <= dateStr) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return best;
  };

  const getRegressionScore = (instId: number, dateStr: string) => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return undefined;
    const idx = getPriceIndex(instId, dateStr);
    if (idx < REG_SHORT) return undefined;
    const closes = prices.map((p) => p.close);
    const slice = closes.slice(idx - REG_SHORT + 1, idx + 1);
    const reg = linearRegression(slice.length >= 60 ? slice : []);
    if (reg.slope <= 0) return undefined;
    return { slope: reg.slope * 252, r2: reg.r2 };
  };

  const getTopFromPool = (pool: number[], dateStr: string, count: number) => {
    type Candidate = { instrumentId: number; slope: number };
    const candidates: Candidate[] = [];
    for (const instId of pool) {
      const price = getPriceOnDate(instId, dateStr);
      if (!price || price < MIN_PRICE) continue;
      const reg = getRegressionScore(instId, dateStr);
      if (!reg) continue;
      candidates.push({ instrumentId: instId, slope: reg.slope });
    }
    candidates.sort((a, b) => b.slope - a.slope);
    return candidates.slice(0, count);
  };

  // ─── Backtest ──────────────────────────────────────────────────────────
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let totalContributed = INITIAL_CAPITAL;
  let benchmarkShares = INITIAL_CAPITAL / (getPriceOnDate(BENCHMARK_ID, tradingDates[0]) || 1);
  const closedTrades: ClosedTrade[] = [];
  const dailyValues: { date: string; value: number }[] = [];

  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyYear = 0;

  for (const day of tradingDates) {
    // Salary
    if (salaryDates.has(day)) {
      cash += MONTHLY_CONTRIBUTION;
      totalContributed += MONTHLY_CONTRIBUTION;
      const bmPrice = getPriceOnDate(BENCHMARK_ID, day);
      if (bmPrice) benchmarkShares += MONTHLY_CONTRIBUTION / bmPrice;
    }

    // Quarterly re-qualification
    const currentYear = Number.parseInt(day.slice(0, 4));
    const currentMonth = Number.parseInt(day.slice(5, 7));
    const currentQ = Math.ceil(currentMonth / 3);
    const qualifyKey = currentYear * 10 + currentQ;

    if (qualifyKey > lastQualifyYear) {
      const avail = latestAvailableQuarter(day);
      qualifiedSmallCaps = await getQualifiedSmallCaps(smallIds, currentYear - 1, avail.year, avail.period);
      lastQualifyYear = qualifyKey;
      log(`Q${currentQ} ${currentYear}: ${qualifiedSmallCaps.size} small caps qualified`);
    }

    // Monthly rebalance
    if (rebalanceSet.has(day)) {
      // Get top candidates from each pool
      const largeMidCandidates = getTopFromPool([...largeMidIdSet], day, LARGE_MID_SLOTS);
      const qualifiedSmallArr = [...qualifiedSmallCaps];
      const smallCandidates = getTopFromPool(qualifiedSmallArr, day, SMALL_SLOTS);

      const allCandidateIds = new Set([
        ...largeMidCandidates.map((c) => c.instrumentId),
        ...smallCandidates.map((c) => c.instrumentId),
      ]);

      // Sell positions not in new targets
      const keepPositions: Position[] = [];
      for (const pos of positions) {
        if (allCandidateIds.has(pos.instrumentId)) {
          keepPositions.push(pos);
        } else {
          const price = getPriceOnDate(pos.instrumentId, day);
          if (price) {
            cash += price * pos.shares;
            const holdDays = Math.round((new Date(day).getTime() - new Date(pos.entryDate).getTime()) / 86400000);
            closedTrades.push({
              instrumentId: pos.instrumentId, name: pos.name, pool: pos.pool,
              entryDate: pos.entryDate, exitDate: day, holdDays,
              entryPrice: pos.entryPrice, exitPrice: price, shares: pos.shares,
              pnl: (price - pos.entryPrice) * pos.shares,
              returnPct: ((price / pos.entryPrice) - 1) * 100,
            });
          }
        }
      }
      positions = keepPositions;

      // Rebalance to equal weight across ALL positions
      const totalSlots = largeMidCandidates.length + smallCandidates.length;
      let pv = cash;
      for (const pos of positions) {
        const p = getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
        pv += pos.shares * p;
      }
      const targetPerStock = pv / Math.max(totalSlots, 1);

      // Trim overweight
      for (const pos of positions) {
        const price = getPriceOnDate(pos.instrumentId, day);
        if (!price) continue;
        const currentValue = pos.shares * price;
        if (currentValue > targetPerStock * 1.01) {
          const sellShares = Math.floor((currentValue - targetPerStock) / price);
          if (sellShares > 0) { cash += sellShares * price; pos.shares -= sellShares; }
        }
      }

      // Top up underweight
      for (const pos of positions) {
        const price = getPriceOnDate(pos.instrumentId, day);
        if (!price) continue;
        const currentValue = pos.shares * price;
        if (currentValue < targetPerStock * 0.99) {
          const buyShares = Math.floor((targetPerStock - currentValue) / price);
          if (buyShares > 0 && cash >= buyShares * price) { cash -= buyShares * price; pos.shares += buyShares; }
        }
      }

      // Buy new entries
      const heldIds = new Set(positions.map((p) => p.instrumentId));
      const allNewCandidates = [
        ...largeMidCandidates.map((c) => ({ ...c, pool: "large" as const })),
        ...smallCandidates.map((c) => ({ ...c, pool: "small" as const })),
      ];
      for (const c of allNewCandidates) {
        if (heldIds.has(c.instrumentId)) continue;
        const price = getPriceOnDate(c.instrumentId, day);
        if (!price) continue;
        const shares = Math.floor(Math.min(targetPerStock, cash) / price);
        if (shares === 0) continue;
        positions.push({ instrumentId: c.instrumentId, name: nameMap.get(c.instrumentId) || "", entryDate: day, entryPrice: price, shares, pool: c.pool });
        cash -= shares * price;
      }
    }

    // Daily value
    let dv = cash;
    for (const pos of positions) {
      const p = getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
      dv += pos.shares * p;
    }
    dailyValues.push({ date: day, value: dv });
  }

  // Close remaining
  const lastDate = tradingDates[tradingDates.length - 1];
  for (const pos of positions) {
    const price = getPriceOnDate(pos.instrumentId, lastDate);
    if (!price) continue;
    const holdDays = Math.round((new Date(lastDate).getTime() - new Date(pos.entryDate).getTime()) / 86400000);
    closedTrades.push({
      instrumentId: pos.instrumentId, name: pos.name, pool: pos.pool,
      entryDate: pos.entryDate, exitDate: lastDate, holdDays,
      entryPrice: pos.entryPrice, exitPrice: price, shares: pos.shares,
      pnl: (price - pos.entryPrice) * pos.shares,
      returnPct: ((price / pos.entryPrice) - 1) * 100,
    });
    cash += price * pos.shares;
  }

  // ─── Results ───────────────────────────────────────────────────────────
  const finalValue = cash;
  const totalReturn = (finalValue / totalContributed - 1) * 100;
  const benchFinal = benchmarkShares * (getPriceOnDate(BENCHMARK_ID, lastDate) || 0);
  const benchReturn = (benchFinal / totalContributed - 1) * 100;
  const alpha = totalReturn - benchReturn;

  let peak = 0, maxDrawdown = 0;
  for (const { value } of dailyValues) {
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const largeTrades = closedTrades.filter((t) => t.pool === "large");
  const smallTrades = closedTrades.filter((t) => t.pool === "small");
  const winners = closedTrades.filter((t) => t.pnl > 0);
  const losers = closedTrades.filter((t) => t.pnl <= 0);
  const grossWins = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const fmtSEK = (n: number) => `${Math.round(n).toLocaleString("sv-SE")} SEK`;

  log("");
  log("═".repeat(80));
  log("VINDROS UNIFIED — Split Slots (10 Large/Mid + 5 Small)");
  log("═".repeat(80));
  log("");
  log("RULES:");
  log(`  • Large/Mid Cap: ${largeMidInstruments.length} stocks → ${LARGE_MID_SLOTS} slots`);
  log(`  • Small/FN/Spotlight: ${smallInstruments.length} → ${qualifiedSmallCaps.size} qualified → ${SMALL_SLOTS} slots`);
  log(`  • Each pool ranked by 90d regression slope`);
  log(`  • Monthly rebalance, equal weight across all ${TOTAL_POSITIONS} slots`);
  log(`  • Contribution: ${MONTHLY_CONTRIBUTION.toLocaleString()}/month`);
  log("");
  log("PERFORMANCE:");
  log(`  Total contributed: ${fmtSEK(totalContributed)}`);
  log(`  Final value:       ${fmtSEK(finalValue)}`);
  log(`  Return:            ${fmtPct(totalReturn)}`);
  log(`  Benchmark:         ${fmtPct(benchReturn)}`);
  log(`  ALPHA:             ${fmtPct(alpha)}`);
  log("");
  log("DRAWDOWN:");
  log(`  Max drawdown:      ${(maxDrawdown * 100).toFixed(1)}%`);
  log("");
  log("POOL BREAKDOWN:");
  log(`  Large/Mid trades:  ${largeTrades.length} (win rate ${((largeTrades.filter(t => t.pnl > 0).length / largeTrades.length) * 100).toFixed(1)}%)`);
  log(`  Small trades:      ${smallTrades.length} (win rate ${((smallTrades.filter(t => t.pnl > 0).length / smallTrades.length) * 100).toFixed(1)}%)`);
  log(`  Large/Mid avg ret: ${fmtPct(largeTrades.reduce((s, t) => s + t.returnPct, 0) / largeTrades.length)}`);
  log(`  Small avg ret:     ${fmtPct(smallTrades.reduce((s, t) => s + t.returnPct, 0) / smallTrades.length)}`);
  log("");
  log("TRADE STATISTICS:");
  log(`  Total trades:      ${closedTrades.length}`);
  log(`  Winners:           ${winners.length} (${((winners.length / closedTrades.length) * 100).toFixed(1)}%)`);
  log(`  Profit factor:     ${profitFactor.toFixed(2)}`);
  log(`  Avg win:           ${fmtPct(winners.length ? winners.reduce((s, t) => s + t.returnPct, 0) / winners.length : 0)}`);
  log(`  Avg loss:          ${fmtPct(losers.length ? losers.reduce((s, t) => s + t.returnPct, 0) / losers.length : 0)}`);

  // ─── NEXT REBALANCE ACTION ─────────────────────────────────────────────
  // Show what the system wants to hold RIGHT NOW (last date = today)
  const today = tradingDates[tradingDates.length - 1];
  const qualifiedSmallArr = [...qualifiedSmallCaps];
  const latestLargeMid = getTopFromPool([...largeMidIdSet], today, LARGE_MID_SLOTS);
  const latestSmall = getTopFromPool(qualifiedSmallArr, today, SMALL_SLOTS);

  log("");
  log("═".repeat(80));
  log(`ACTION — Rebalance on ${today}`);
  log("═".repeat(80));
  log("");
  log("CORE (Large/Mid Cap — top 10 by 90d slope):");
  for (let i = 0; i < latestLargeMid.length; i++) {
    const c = latestLargeMid[i];
    const price = getPriceOnDate(c.instrumentId, today);
    log(`  ${String(i + 1).padStart(2)}. ${(nameMap.get(c.instrumentId) || "").padEnd(25)} slope: ${c.slope.toFixed(2).padStart(7)}  price: ${price?.toFixed(1)}`);
  }
  log("");
  log("FUNDAMENTALS (Quality Small Caps — top 5 by 90d slope):");
  if (latestSmall.length === 0) {
    log("  (none qualify)");
  } else {
    for (let i = 0; i < latestSmall.length; i++) {
      const c = latestSmall[i];
      const price = getPriceOnDate(c.instrumentId, today);
      log(`  ${String(i + 1).padStart(2)}. ${(nameMap.get(c.instrumentId) || "").padEnd(25)} slope: ${c.slope.toFixed(2).padStart(7)}  price: ${price?.toFixed(1)}`);
    }
  }
  log("");
  log(`QUALIFIED SMALL CAPS (${qualifiedSmallCaps.size} total passing filter):`);
  const allQualifiedWithSlope = qualifiedSmallArr
    .map(id => ({ id, name: nameMap.get(id) || "", reg: getRegressionScore(id, today) }))
    .filter(x => x.reg)
    .sort((a, b) => b.reg!.slope - a.reg!.slope);
  for (const q of allQualifiedWithSlope) {
    const inTop = latestSmall.some(c => c.instrumentId === q.id);
    log(`  ${inTop ? "→" : " "} ${q.name.padEnd(25)} slope: ${q.reg!.slope.toFixed(2)}`);
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`\nOutput: ${OUTPUT_FILE}`);
  await prisma.$disconnect();
};

run().catch((err) => { console.error(err); process.exit(1); });
