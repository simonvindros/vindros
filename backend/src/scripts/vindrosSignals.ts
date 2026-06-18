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

// Parse --reg=N from CLI args (default 90)
const regArg = process.argv.find((a) => a.startsWith("--reg="));
const REG_WINDOW = regArg ? parseInt(regArg.split("=")[1]) : 90;

const OUTPUT_FILE = path.join(
  __dirname,
  REG_WINDOW === 90
    ? "../../vindros_signals.txt"
    : `../../vindros_signals_${REG_WINDOW}d.txt`,
);
const PORTFOLIO_FILE = path.join(__dirname, "../../vindros_portfolio.json");
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const EXECUTE_MODE = process.argv.includes("--execute");

// Configuration (same as vindros_final)
const TOTAL_POSITIONS = 15;
const BENCHMARK_ID = 638;
const REG_SHORT = REG_WINDOW;
const MIN_PRICE = 10;
const MAX_ADV_FRACTION = 0.1; // Position must be <10% of 20-day avg daily turnover
const ADV_LOOKBACK = 20;
const MIN_R2 = 0.6; // Minimum R² — exclude choppy trends
const LARGE_MID_MARKETS = [1, 2];
const SMALL_MARKETS = [3, 4, 5];

// Fundamental thresholds
const MIN_REVENUE_GROWTH = 10;
const MIN_REVENUE_MSEK = 50;
const MIN_OPERATING_MARGIN = 5;
const MIN_YEARS_DATA = 3;
const KPI_REVENUE_GROWTH = 94;
const KPI_OPERATING_MARGIN = 29;
const KPI_REVENUE = 53;

type PriceRow = { date: Date; close: number; volume: number };
type Holding = { name: string; shares: number; avgPrice: number };
type Portfolio = {
  holdings: Record<string, Holding>;
  cash: number;
  lastUpdated: string;
};

const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function latestAvailableQuarter(): { year: number; period: number } {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const currentQ = Math.ceil(month / 3);
  if (currentQ === 1) return { year: year - 1, period: 4 };
  return { year, period: currentQ - 1 };
}

async function getQualifiedSmallCaps(
  instrumentIds: number[],
): Promise<Set<number>> {
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
      const latest = [...revenueMap.entries()]
        .filter(([y]) => y <= asOfYear)
        .sort((a, b) => a[0] - b[0])
        .pop();
      if (latest && latest[1] < MIN_REVENUE_MSEK) continue;
    }

    const opMarginMap = kpiMap.get(KPI_OPERATING_MARGIN);
    if (!opMarginMap) continue;
    const opMargins = [...opMarginMap.entries()]
      .filter(([y]) => y <= asOfYear)
      .sort((a, b) => a[0] - b[0]);
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
    select: {
      instrumentId: true,
      kpiId: true,
      year: true,
      period: true,
      value: true,
    },
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }, { period: "asc" }],
  });

  const cutoff = avail.year * 10 + avail.period;
  const qData = new Map<
    number,
    Map<number, Array<{ key: number; value: number }>>
  >();
  for (const kv of quarterlyKpis) {
    if (kv.value === null || kv.period === null) continue;
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
    if (!instQ) {
      qualified.add(instId);
      continue;
    }

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
  const nameMap = new Map<number, string>(
    allInstruments.map((i) => [i.id, i.name]),
  );
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
    select: { instrumentId: true, date: true, close: true, volume: true },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  });

  const pricesByInstrument = new Map<number, PriceRow[]>();
  for (const p of allPrices) {
    if (!pricesByInstrument.has(p.instrumentId))
      pricesByInstrument.set(p.instrumentId, []);
    pricesByInstrument.get(p.instrumentId)!.push({
      date: p.date,
      close: Number(p.close),
      volume: Number(p.volume ?? 0),
    });
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
    // Stale price guard: skip stocks not traded in last 7 days
    const lastPriceDate = prices[prices.length - 1].date
      .toISOString()
      .slice(0, 10);
    const daysDiff =
      (new Date(today).getTime() - new Date(lastPriceDate).getTime()) /
      86400000;
    if (daysDiff > 7) return undefined;
    const closes = prices.map((p) => p.close);
    const slice = closes.slice(-REG_SHORT);
    const reg = linearRegression(slice);
    if (reg.slope <= 0) return undefined;
    if (reg.r2 < MIN_R2) return undefined;
    return reg.slope * 252;
  };

  const getADV = (instId: number): number => {
    const prices = pricesByInstrument.get(instId);
    if (!prices || prices.length < ADV_LOOKBACK) return 0;
    let totalTurnover = 0;
    for (let i = prices.length - ADV_LOOKBACK; i < prices.length; i++) {
      totalTurnover += prices[i].close * prices[i].volume;
    }
    return totalTurnover / ADV_LOOKBACK;
  };

  // Rank pools
  type Candidate = {
    instrumentId: number;
    name: string;
    slope: number;
    price: number;
  };

  const rankPool = (
    pool: number[],
    estimatedPositionSize: number,
    checkLiquidity: boolean,
  ): Candidate[] => {
    const candidates: Candidate[] = [];
    for (const instId of pool) {
      const price = getLatestPrice(instId);
      if (!price || price < MIN_PRICE) continue;
      if (checkLiquidity) {
        const adv = getADV(instId);
        if (adv > 0 && estimatedPositionSize / adv > MAX_ADV_FRACTION) continue;
      }
      const slope = getSlope(instId);
      if (!slope) continue;
      candidates.push({
        instrumentId: instId,
        name: nameMap.get(instId) || "",
        slope,
        price,
      });
    }
    candidates.sort((a, b) => b.slope - a.slope);
    return candidates;
  };

  // Load current portfolio (needed for liquidity filter position size estimate)
  let portfolio: Portfolio | null = null;
  if (fs.existsSync(PORTFOLIO_FILE)) {
    portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
  }

  // Estimate position size from portfolio (or initial buy assumption)
  let portfolioValue = 0;
  if (portfolio) {
    portfolioValue = portfolio.cash;
    for (const [name, h] of Object.entries(portfolio.holdings)) {
      const inst = allInstruments.find((i) => i.name === name);
      if (inst) {
        const price = getLatestPrice(inst.id) || h.avgPrice;
        portfolioValue += h.shares * price;
      } else {
        portfolioValue += h.shares * h.avgPrice;
      }
    }
  }
  const estPositionSize =
    portfolioValue > 0 ? portfolioValue / TOTAL_POSITIONS : 0;

  // Get targets — unified pool: all eligible compete for 15 slots
  const qualifiedSmall = await getQualifiedSmallCaps(smallIds);

  // Rank all eligible stocks together
  const largeMidRanked = rankPool([...largeMidIdSet], estPositionSize, estPositionSize > 0);
  const smallRanked = rankPool(
    [...qualifiedSmall],
    estPositionSize,
    estPositionSize > 0,
  );

  // Merge and sort by slope — head-to-head competition
  const allEligible = [
    ...largeMidRanked.map((c) => ({ ...c, pool: "large" as const })),
    ...smallRanked.map((c) => ({ ...c, pool: "small" as const })),
  ].sort((a, b) => b.slope - a.slope);

  const allTargets = allEligible.slice(0, TOTAL_POSITIONS);
  const targetNames = new Set(allTargets.map((t) => t.name));

  // Diff against portfolio
  log("");
  log("═".repeat(60));
  log("ACTIONS:");
  log("═".repeat(60));
  log("");

  if (!portfolio) {
    portfolio = { holdings: {}, cash: INITIAL_CAPITAL, lastUpdated: "" };
  }

  {
    const heldNames = new Set(Object.keys(portfolio.holdings));

    // What to SELL (held but not in target)
    const sells = [...heldNames]
      .filter((name) => !targetNames.has(name))
      .sort((a, b) => a.localeCompare(b, "sv"));
    if (sells.length > 0) {
      log("  SELL (no longer in target):");
      for (const name of sells) {
        const h = portfolio.holdings[name];
        log(`    ✗ ${name.padEnd(28)} sell all ${h.shares} shares`);
      }
      log("");
    }

    // What to BUY (in target but not held)
    const buys = allTargets
      .filter((t) => !heldNames.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name, "sv"));
    if (buys.length > 0) {
      log("  BUY (new entries):");
      for (const t of buys) {
        log(
          `    ✓ ${t.name.padEnd(28)} ~${t.price.toFixed(1)} SEK  slope: ${t.slope.toFixed(2)}`,
        );
      }
      log("");
    }

    // Calculate total portfolio value after sells
    let portfolioValue = portfolio.cash;
    for (const name of heldNames) {
      if (targetNames.has(name)) {
        const h = portfolio.holdings[name];
        const target = allTargets.find((t) => t.name === name);
        if (target) portfolioValue += h.shares * target.price;
      }
    }
    // Add proceeds from sells
    for (const name of sells) {
      const h = portfolio.holdings[name];
      const target = allTargets.find((t) => t.name === name);
      const price = target ? target.price : h.avgPrice;
      portfolioValue += h.shares * price;
    }
    // Add monthly contribution only on subsequent months (not the initial investment month)
    const lastUpdated = portfolio.lastUpdated
      ? new Date(portfolio.lastUpdated)
      : null;
    const now = new Date();
    const isNewMonth =
      lastUpdated &&
      (lastUpdated.getFullYear() < now.getFullYear() ||
        lastUpdated.getMonth() < now.getMonth());
    if (heldNames.size > 0 && isNewMonth) {
      portfolioValue += MONTHLY_CONTRIBUTION;
    }

    const targetPerStock = portfolioValue / TOTAL_POSITIONS;

    log(
      `  REBALANCE (target: ${Math.round(targetPerStock).toLocaleString("sv-SE")} SEK/position, portfolio: ${Math.round(portfolioValue).toLocaleString("sv-SE")} SEK):`,
    );
    log("");
    log("  Stock                          Current  Target   Action");
    log("  " + "─".repeat(58));

    // All target stocks sorted alphabetically
    const allTargetsSorted = [...allTargets].sort((a, b) =>
      a.name.localeCompare(b.name, "sv"),
    );
    for (const t of allTargetsSorted) {
      const currentShares = portfolio.holdings[t.name]?.shares ?? 0;
      const targetShares = Math.floor(targetPerStock / t.price);
      const diff = targetShares - currentShares;
      let action: string;
      if (diff > 0) action = `buy ${diff}`;
      else if (diff < 0) action = `sell ${Math.abs(diff)}`;
      else action = "hold";
      log(
        `  ${t.name.padEnd(28)} ${String(currentShares).padStart(7)}  ${String(targetShares).padStart(6)}   ${action}`,
      );
    }
    log("  " + "─".repeat(58));

    // Show cash after rebalance
    let totalInvested = 0;
    for (const t of allTargets) {
      const targetShares = Math.floor(targetPerStock / t.price);
      totalInvested += targetShares * t.price;
    }
    const cashAfter = portfolioValue - totalInvested;
    log(
      `  CASH AFTER REBALANCE: ${Math.round(cashAfter).toLocaleString("sv-SE")} SEK`,
    );

    // Update portfolio if executing
    if (EXECUTE_MODE) {
      const newHoldings: Record<string, Holding> = {};
      for (const t of allTargets) {
        const targetShares = Math.floor(targetPerStock / t.price);
        const oldHolding = portfolio.holdings[t.name];
        // Weighted average price for new buys
        const currentShares = oldHolding?.shares ?? 0;
        const currentAvg = oldHolding?.avgPrice ?? t.price;
        let newAvg: number;
        if (currentShares === 0) {
          newAvg = t.price;
        } else if (targetShares > currentShares) {
          // Buying more — blend avg price
          const newShares = targetShares - currentShares;
          newAvg =
            (currentShares * currentAvg + newShares * t.price) / targetShares;
        } else {
          // Selling or holding — keep existing avg
          newAvg = currentAvg;
        }
        newHoldings[t.name] = {
          name: t.name,
          shares: targetShares,
          avgPrice: newAvg,
        };
      }
      const portfolioData: Portfolio = {
        holdings: newHoldings,
        cash: cashAfter,
        lastUpdated: today,
      };
      fs.writeFileSync(
        PORTFOLIO_FILE,
        JSON.stringify(portfolioData, null, 2),
        "utf-8",
      );
      log("");
      log(`  ✓ Portfolio updated → ${PORTFOLIO_FILE}`);
    } else {
      log("");
      log(
        `  → Run with --execute to save: npm run vindros:signals -- --execute`,
      );
    }
  }

  // Write output
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`\nOutput: ${OUTPUT_FILE}`);
  await prisma.$disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
