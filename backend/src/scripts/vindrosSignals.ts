/**
 * VINDROS SIGNALS — Actionable monthly rebalance output
 *
 * Fast signal-only mode: no backtest, just computes today's target portfolio
 * and diffs against your actual holdings (vindros_portfolio.json).
 *
 * Outputs: what to BUY, SELL, HOLD, and REBALANCE.
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "../backtest/utils";

const OUTPUT_FILE = path.join(__dirname, "../../vindros_signals.txt");
const PORTFOLIO_FILE = path.join(__dirname, "../../vindros_portfolio.json");

// Configuration (same as vindros_final)
const LARGE_MID_SLOTS = 10;
const SMALL_SLOTS = 5;
const BENCHMARK_ID = 638;
const REG_SHORT = 90;
const MIN_PRICE = 10;
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

type PriceRow = { date: Date; close: number };
type Holding = { name: string; shares: number; avgPrice: number };
type Portfolio = { holdings: Record<string, Holding>; cash: number; lastUpdated: string };

const lines: string[] = [];
const log = (msg = "") => { lines.push(msg); console.log(msg); };

// ─── Helpers ─────────────────────────────────────────────────────────────────
function latestAvailableQuarter(): { year: number; period: number } {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const currentQ = Math.ceil(month / 3);
  if (currentQ === 1) return { year: year - 1, period: 4 };
  return { year, period: currentQ - 1 };
}

async function getQualifiedSmallCaps(instrumentIds: number[]): Promise<Set<number>> {
  const currentYear = new Date().getFullYear();
  const asOfYear = currentYear - 1;
  const avail = latestAvailableQuarter();

  // Annual baseline
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

  // Quarterly freshness check
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

  const cutoff = avail.year * 10 + avail.period;
  const qData = new Map<number, Map<number, Array<{ key: number; value: number }>>>();
  for (const kv of quarterlyKpis) {
    if (kv.value === null) continue;
    const key = kv.year * 10 + kv.period;
    if (key > cutoff) continue;
    if (!qData.has(kv.instrumentId)) qData.set(kv.instrumentId, new Map());
    const instMap = qData.get(kv.instrumentId)!;
    if (!instMap.has(kv.kpiId)) instMap.set(kv.kpiId, []);
    instMap.get(kv.kpiId)!.push({ key, value: Number(kv.value) });
  }

  const qualified = new Set<number>();
  for (const instId of annualQualified) {
    const instQ = qData.get(instId);
    if (!instQ) { qualified.add(instId); continue; }

    const revQ = instQ.get(KPI_REVENUE_GROWTH);
    if (revQ && revQ.length > 0) {
      revQ.sort((a, b) => a.key - b.key);
      if (revQ[revQ.length - 1].value < -10) continue;
    }
    const margQ = instQ.get(KPI_OPERATING_MARGIN);
    if (margQ && margQ.length > 0) {
      margQ.sort((a, b) => a.key - b.key);
      if (margQ[margQ.length - 1].value < 0) continue;
    }
    qualified.add(instId);
  }

  return qualified;
}

// ─── Main ────────────────────────────────────────────────────────────────────
const run = async () => {
  const today = new Date().toISOString().slice(0, 10);
  log(`VINDROS SIGNALS — ${today}`);
  log("═".repeat(60));

  // Load instruments
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

  // Load last 150 days of prices
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 150);

  const allPrices = await prisma.stockPrice.findMany({
    where: {
      instrumentId: { in: allIds },
      date: { gte: startDate },
    },
    select: { instrumentId: true, date: true, close: true },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  });

  const pricesByInstrument = new Map<number, PriceRow[]>();
  for (const p of allPrices) {
    if (!pricesByInstrument.has(p.instrumentId)) pricesByInstrument.set(p.instrumentId, []);
    pricesByInstrument.get(p.instrumentId)!.push({ date: p.date, close: Number(p.close) });
  }

  // Get latest price and slope for each instrument
  const getLatestPrice = (instId: number): number | undefined => {
    const prices = pricesByInstrument.get(instId);
    if (!prices || prices.length === 0) return undefined;
    return prices[prices.length - 1].close;
  };

  const getSlope = (instId: number): number | undefined => {
    const prices = pricesByInstrument.get(instId);
    if (!prices || prices.length < REG_SHORT) return undefined;
    const closes = prices.map((p) => p.close);
    const slice = closes.slice(-REG_SHORT);
    const reg = linearRegression(slice);
    if (reg.slope <= 0) return undefined;
    return reg.slope * 252;
  };

  // Rank pools
  type Candidate = { instrumentId: number; name: string; slope: number; price: number };

  const rankPool = (pool: number[]): Candidate[] => {
    const candidates: Candidate[] = [];
    for (const instId of pool) {
      const price = getLatestPrice(instId);
      if (!price || price < MIN_PRICE) continue;
      const slope = getSlope(instId);
      if (!slope) continue;
      candidates.push({ instrumentId: instId, name: nameMap.get(instId) || "", slope, price });
    }
    candidates.sort((a, b) => b.slope - a.slope);
    return candidates;
  };

  // Get targets
  const largeMidRanked = rankPool([...largeMidIdSet]);
  const coreTargets = largeMidRanked.slice(0, LARGE_MID_SLOTS);

  const qualifiedSmall = await getQualifiedSmallCaps(smallIds);
  const smallRanked = rankPool([...qualifiedSmall]);
  const fundTargets = smallRanked.slice(0, SMALL_SLOTS);

  const allTargets = [...coreTargets, ...fundTargets];
  const targetNames = new Set(allTargets.map((t) => t.name));

  // Load current portfolio
  let portfolio: Portfolio | null = null;
  if (fs.existsSync(PORTFOLIO_FILE)) {
    portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
  }

  // Output targets
  log("");
  log("TARGET PORTFOLIO:");
  log("─".repeat(60));
  log("");
  log("CORE (Large/Mid Cap — top 10 by 90d slope):");
  for (let i = 0; i < coreTargets.length; i++) {
    const t = coreTargets[i];
    log(`  ${String(i + 1).padStart(2)}. ${t.name.padEnd(28)} ${t.price.toFixed(1).padStart(8)} SEK  slope: ${t.slope.toFixed(2)}`);
  }
  log("");
  log(`FUNDAMENTALS (Quality Small Caps — top 5 of ${qualifiedSmall.size} qualified):`);
  for (let i = 0; i < fundTargets.length; i++) {
    const t = fundTargets[i];
    log(`  ${String(i + 1).padStart(2)}. ${t.name.padEnd(28)} ${t.price.toFixed(1).padStart(8)} SEK  slope: ${t.slope.toFixed(2)}`);
  }

  // Diff against portfolio
  log("");
  log("═".repeat(60));
  log("ACTIONS:");
  log("═".repeat(60));
  log("");

  if (!portfolio) {
    log("  No vindros_portfolio.json found.");
    log("  Create it after executing trades with: npm run vindros:update-portfolio");
    log("");
    log("  INITIAL BUY — equal weight across 15 positions:");
    log("  Allocate portfolio value ÷ 15 into each target above.");
  } else {
    const heldNames = new Set(Object.keys(portfolio.holdings));

    // What to SELL (held but not in target)
    const sells = [...heldNames].filter((name) => !targetNames.has(name));
    if (sells.length > 0) {
      log("  SELL (no longer in target):");
      for (const name of sells) {
        const h = portfolio.holdings[name];
        log(`    ✗ ${name.padEnd(28)} ${h.shares} shares`);
      }
      log("");
    }

    // What to BUY (in target but not held)
    const buys = allTargets.filter((t) => !heldNames.has(t.name));
    if (buys.length > 0) {
      log("  BUY (new entries):");
      for (const t of buys) {
        log(`    ✓ ${t.name.padEnd(28)} ~${t.price.toFixed(1)} SEK  slope: ${t.slope.toFixed(2)}`);
      }
      log("");
    }

    // What to HOLD (in both)
    const holds = allTargets.filter((t) => heldNames.has(t.name));
    if (holds.length > 0) {
      log("  HOLD (still in target):");
      for (const t of holds) {
        const h = portfolio.holdings[t.name];
        const currentValue = h.shares * t.price;
        const returnPct = ((t.price / h.avgPrice) - 1) * 100;
        log(`    ● ${t.name.padEnd(28)} ${h.shares} shares  ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(1)}%`);
      }
      log("");
    }

    // Rebalance note
    if (sells.length > 0 || buys.length > 0) {
      log("  REBALANCE:");
      log("    After executing sells/buys, equal-weight all 15 positions.");
      log(`    Target per stock: total portfolio value ÷ 15`);
    }
  }

  // Write output
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`\nOutput: ${OUTPUT_FILE}`);
  await prisma.$disconnect();
};

run().catch((err) => { console.error(err); process.exit(1); });
