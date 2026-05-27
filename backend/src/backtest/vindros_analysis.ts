/**
 * VINDROS FINAL — Detailed Monthly Analysis
 *
 * Same logic as vindros_final.ts but outputs rich monthly snapshots:
 * - Portfolio state each month (holdings, values, weights)
 * - Why each stock was selected (slope for core, KPI data for fundamentals)
 * - What changed (bought/sold and why)
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

const OUTPUT_FILE = path.join(__dirname, "vindros_analysis_output.txt");
const lines: string[] = [];
const log = (msg = "") => { lines.push(msg); console.log(msg); };

// ─── Configuration (same as vindros_final) ───────────────────────────────────
const START_DATE = new Date("2018-01-01");
const END_DATE = new Date("2026-05-22");
const LARGE_MID_SLOTS = 10;
const SMALL_SLOTS = 5;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const BENCHMARK_ID = 638;
const REG_SHORT = 90;
const MIN_PRICE = 10;
const SALARY_DAY = 23;
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

// ─── KPI data store (kept in memory for explanations) ────────────────────────
type KpiData = Map<number, Map<number, Map<number, number>>>; // instId → kpiId → year → value
let kpiData: KpiData = new Map();

// Quarterly KPI data: instId → kpiId → sorted array of {key, value}
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

  // Load quarterly data for freshness checks
  const qKpiValues = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: instrumentIds },
      kpiId: { in: [KPI_REVENUE_GROWTH, KPI_OPERATING_MARGIN] },
      reportType: "quarter",
      priceType: "mean",
    },
    select: { instrumentId: true, kpiId: true, year: true, period: true, value: true },
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }, { period: "asc" }],
  });

  for (const kv of qKpiValues) {
    if (kv.value === null) continue;
    if (!qKpiData.has(kv.instrumentId)) qKpiData.set(kv.instrumentId, new Map());
    const instMap = qKpiData.get(kv.instrumentId)!;
    if (!instMap.has(kv.kpiId)) instMap.set(kv.kpiId, []);
    instMap.get(kv.kpiId)!.push({ key: kv.year * 10 + (kv.period ?? 0), value: Number(kv.value) });
  }

  // Sort quarterly arrays
  for (const instMap of qKpiData.values()) {
    for (const arr of instMap.values()) {
      arr.sort((a, b) => a.key - b.key);
    }
  }
}

function latestAvailableQuarter(dateStr: string): { year: number; period: number } {
  const month = Number.parseInt(dateStr.slice(5, 7));
  const year = Number.parseInt(dateStr.slice(0, 4));
  const currentQ = Math.ceil(month / 3);
  if (currentQ === 1) return { year: year - 1, period: 4 };
  return { year, period: currentQ - 1 };
}

function getQualifiedSmallCaps(instrumentIds: number[], asOfYear: number, asOfQuarterYear: number, asOfPeriod: number): Set<number> {
  // 1) Annual baseline qualification
  const annualQualified = new Set<number>();

  for (const instId of instrumentIds) {
    const kpiMap = kpiData.get(instId);
    if (!kpiMap) continue;

    const revGrowthMap = kpiMap.get(KPI_REVENUE_GROWTH);
    if (!revGrowthMap) continue;

    const revGrowthYears = [...revGrowthMap.entries()].filter(([y]) => y <= asOfYear).sort((a, b) => a[0] - b[0]);
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

  // 2) Quarterly freshness check
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
      const available = revQ.filter(x => x.key <= cutoff);
      if (available.length > 0 && available[available.length - 1].value < -10) continue;
    }

    const margQ = instQ.get(KPI_OPERATING_MARGIN);
    if (margQ && margQ.length > 0) {
      const available = margQ.filter(x => x.key <= cutoff);
      if (available.length > 0 && available[available.length - 1].value < 0) continue;
    }

    qualified.add(instId);
  }

  return qualified;
}

function explainQualification(instId: number, asOfYear: number): string {
  const kpiMap = kpiData.get(instId);
  if (!kpiMap) return "  (no KPI data)";

  const parts: string[] = [];

  const revGrowthMap = kpiMap.get(KPI_REVENUE_GROWTH);
  if (revGrowthMap) {
    const years = [...revGrowthMap.entries()].filter(([y]) => y <= asOfYear).sort((a, b) => a[0] - b[0]).slice(-5);
    const avg = years.reduce((s, [, v]) => s + v, 0) / years.length;
    parts.push(`      Rev growth: ${years.map(([y, v]) => `${y}:${v.toFixed(0)}%`).join(", ")} → avg ${avg.toFixed(1)}%`);
  }

  const revenueMap = kpiMap.get(KPI_REVENUE);
  if (revenueMap) {
    const latest = [...revenueMap.entries()].filter(([y]) => y <= asOfYear).sort((a, b) => a[0] - b[0]).pop();
    if (latest) parts.push(`      Revenue: ${latest[1].toFixed(0)} MSEK (${latest[0]})`);
  }

  const opMarginMap = kpiMap.get(KPI_OPERATING_MARGIN);
  if (opMarginMap) {
    const margins = [...opMarginMap.entries()].filter(([y]) => y <= asOfYear).sort((a, b) => a[0] - b[0]).slice(-4);
    parts.push(`      Op margin: ${margins.map(([y, v]) => `${y}:${v.toFixed(1)}%`).join(", ")}`);
  }

  return parts.join("\n");
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

  // Load KPI data for explanations
  await loadKpiData(smallIds);

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

  // Trading days
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
  if (tradingDates.length > 0) monthEnds.push(tradingDates[tradingDates.length - 1]);
  const monthEndSet = new Set(monthEnds);

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

  // ─── Helpers ─────────────────────────────────────────────────────────────
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
    type Candidate = { instrumentId: number; slope: number; r2: number };
    const candidates: Candidate[] = [];
    for (const instId of pool) {
      const price = getPriceOnDate(instId, dateStr);
      if (!price || price < MIN_PRICE) continue;
      const reg = getRegressionScore(instId, dateStr);
      if (!reg) continue;
      candidates.push({ instrumentId: instId, slope: reg.slope, r2: reg.r2 });
    }
    candidates.sort((a, b) => b.slope - a.slope);
    return candidates.slice(0, count);
  };

  // ─── Backtest Loop ─────────────────────────────────────────────────────
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let totalContributed = INITIAL_CAPITAL;
  let benchmarkShares = INITIAL_CAPITAL / (getPriceOnDate(BENCHMARK_ID, tradingDates[0]) || 1);

  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyYear = 0;
  let monthCount = 0;

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
      qualifiedSmallCaps = getQualifiedSmallCaps(smallIds, currentYear - 1, avail.year, avail.period);
      lastQualifyYear = qualifyKey;
    }

    // Monthly rebalance
    if (monthEndSet.has(day)) {
      monthCount++;
      const largeMidCandidates = getTopFromPool([...largeMidIdSet], day, LARGE_MID_SLOTS);
      const qualifiedSmallArr = [...qualifiedSmallCaps];
      const smallCandidates = getTopFromPool(qualifiedSmallArr, day, SMALL_SLOTS);

      const allCandidateIds = new Set([
        ...largeMidCandidates.map((c) => c.instrumentId),
        ...smallCandidates.map((c) => c.instrumentId),
      ]);

      // Determine sells
      const sells: { name: string; pool: string; reason: string; returnPct: string }[] = [];
      const keepPositions: Position[] = [];
      for (const pos of positions) {
        if (allCandidateIds.has(pos.instrumentId)) {
          keepPositions.push(pos);
        } else {
          const price = getPriceOnDate(pos.instrumentId, day);
          if (price) {
            const ret = ((price / pos.entryPrice) - 1) * 100;
            const reason = pos.pool === "large" ? "dropped from top 10 by slope" : "dropped from top 5 by slope";
            sells.push({ name: pos.name, pool: pos.pool, reason, returnPct: `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%` });
            cash += price * pos.shares;
          }
        }
      }
      positions = keepPositions;

      // Determine buys
      const heldIds = new Set(positions.map((p) => p.instrumentId));
      const buys: { name: string; pool: string; slope: number; reason: string }[] = [];
      for (const c of largeMidCandidates) {
        if (!heldIds.has(c.instrumentId)) {
          buys.push({ name: nameMap.get(c.instrumentId) || "", pool: "large", slope: c.slope, reason: `#${largeMidCandidates.indexOf(c) + 1} by slope (${c.slope.toFixed(2)})` });
        }
      }
      for (const c of smallCandidates) {
        if (!heldIds.has(c.instrumentId)) {
          buys.push({ name: nameMap.get(c.instrumentId) || "", pool: "small", slope: c.slope, reason: `#${smallCandidates.indexOf(c) + 1} qualified by fundamentals + slope (${c.slope.toFixed(2)})` });
        }
      }

      // Rebalance
      const totalSlots = largeMidCandidates.length + smallCandidates.length;
      let pv = cash;
      for (const pos of positions) {
        pv += (getPriceOnDate(pos.instrumentId, day) || pos.entryPrice) * pos.shares;
      }
      const targetPerStock = pv / Math.max(totalSlots, 1);

      // Trim/top-up existing
      for (const pos of positions) {
        const price = getPriceOnDate(pos.instrumentId, day);
        if (!price) continue;
        const currentValue = pos.shares * price;
        if (currentValue > targetPerStock * 1.01) {
          const sellShares = Math.floor((currentValue - targetPerStock) / price);
          if (sellShares > 0) { cash += sellShares * price; pos.shares -= sellShares; }
        } else if (currentValue < targetPerStock * 0.99) {
          const buyShares = Math.floor((targetPerStock - currentValue) / price);
          if (buyShares > 0 && cash >= buyShares * price) { cash -= buyShares * price; pos.shares += buyShares; }
        }
      }

      // Buy new entries
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

      // ─── LOG MONTHLY SNAPSHOT ────────────────────────────────────────
      let portfolioValue = cash;
      for (const pos of positions) {
        portfolioValue += (getPriceOnDate(pos.instrumentId, day) || pos.entryPrice) * pos.shares;
      }
      const bmValue = benchmarkShares * (getPriceOnDate(BENCHMARK_ID, day) || 0);

      log("");
      log("━".repeat(80));
      log(`MONTH ${monthCount} — ${day}   Portfolio: ${Math.round(portfolioValue).toLocaleString("sv-SE")} SEK   Benchmark: ${Math.round(bmValue).toLocaleString("sv-SE")} SEK`);
      log("━".repeat(80));

      // Changes
      if (sells.length > 0 || buys.length > 0) {
        log("");
        if (sells.length > 0) {
          log("  SOLD:");
          for (const s of sells) log(`    ✗ ${s.name.padEnd(25)} [${s.pool}] ${s.returnPct.padStart(7)} — ${s.reason}`);
        }
        if (buys.length > 0) {
          log("  BOUGHT:");
          for (const b of buys) log(`    ✓ ${b.name.padEnd(25)} [${b.pool}] — ${b.reason}`);
        }
      } else {
        log("  No changes (all positions retained).");
      }

      // Holdings
      log("");
      log("  CORE HOLDINGS (Large/Mid Cap — ranked by 90d slope):");
      for (let i = 0; i < largeMidCandidates.length; i++) {
        const c = largeMidCandidates[i];
        const price = getPriceOnDate(c.instrumentId, day) || 0;
        const pos = positions.find(p => p.instrumentId === c.instrumentId);
        const value = pos ? pos.shares * price : 0;
        const weight = ((value / portfolioValue) * 100).toFixed(1);
        const held = pos ? `held since ${pos.entryDate}` : "new";
        const returnSinceEntry = pos ? `${((price / pos.entryPrice - 1) * 100).toFixed(1)}%` : "";
        log(`    ${String(i + 1).padStart(2)}. ${(nameMap.get(c.instrumentId) || "").padEnd(25)} ${price.toFixed(1).padStart(8)} SEK  slope:${c.slope.toFixed(2).padStart(6)}  wt:${weight}%  ${held} ${returnSinceEntry}`);
      }

      log("");
      log("  FUNDAMENTAL HOLDINGS (Quality Small Caps):");
      if (smallCandidates.length === 0) {
        log("    (none qualify with positive slope)");
      } else {
        for (let i = 0; i < smallCandidates.length; i++) {
          const c = smallCandidates[i];
          const price = getPriceOnDate(c.instrumentId, day) || 0;
          const pos = positions.find(p => p.instrumentId === c.instrumentId);
          const value = pos ? pos.shares * price : 0;
          const weight = ((value / portfolioValue) * 100).toFixed(1);
          const held = pos ? `held since ${pos.entryDate}` : "new";
          const returnSinceEntry = pos ? `${((price / pos.entryPrice - 1) * 100).toFixed(1)}%` : "";
          log(`    ${String(i + 1).padStart(2)}. ${(nameMap.get(c.instrumentId) || "").padEnd(25)} ${price.toFixed(1).padStart(8)} SEK  slope:${c.slope.toFixed(2).padStart(6)}  wt:${weight}%  ${held} ${returnSinceEntry}`);
          // Show WHY this stock qualified
          log(explainQualification(c.instrumentId, currentYear - 1));
        }
      }

      // Cash position
      const cashPct = ((cash / portfolioValue) * 100).toFixed(1);
      log("");
      log(`  CASH: ${Math.round(cash).toLocaleString("sv-SE")} SEK (${cashPct}%)`);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  const lastDate = tradingDates[tradingDates.length - 1];
  let finalValue = cash;
  for (const pos of positions) {
    const price = getPriceOnDate(pos.instrumentId, lastDate) || pos.entryPrice;
    finalValue += pos.shares * price;
  }
  const totalReturn = (finalValue / totalContributed - 1) * 100;
  const benchFinal = benchmarkShares * (getPriceOnDate(BENCHMARK_ID, lastDate) || 0);
  const benchReturn = (benchFinal / totalContributed - 1) * 100;

  log("");
  log("═".repeat(80));
  log("SUMMARY");
  log("═".repeat(80));
  log(`  Months:       ${monthCount}`);
  log(`  Contributed:  ${totalContributed.toLocaleString("sv-SE")} SEK`);
  log(`  Final value:  ${Math.round(finalValue).toLocaleString("sv-SE")} SEK`);
  log(`  Return:       ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(1)}%`);
  log(`  Benchmark:    ${benchReturn >= 0 ? "+" : ""}${benchReturn.toFixed(1)}%`);
  log(`  ALPHA:        ${(totalReturn - benchReturn) >= 0 ? "+" : ""}${(totalReturn - benchReturn).toFixed(1)}%`);

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`\nOutput: ${OUTPUT_FILE}`);
  await prisma.$disconnect();
};

run().catch((err) => { console.error(err); process.exit(1); });
