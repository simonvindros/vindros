/**
 * VINDROS DYNAMIC SIGNALS — Actionable monthly rebalance for the 3-slot strategy
 *
 * Computes today's target portfolio using the dynamic allocation mechanic:
 *   - 3 target positions, ADV overflow to #4, #5, etc.
 *   - A→B share substitution for liquidity
 *   - No operating margin filter (dynamic variant)
 *   - Quarterly freshness check (revenue growth only)
 *
 * Diffs against vindros_portfolio.json and outputs BUY/SELL/HOLD actions.
 *
 * Usage:
 *   cd backend
 *   TS_NODE_COMPILER_OPTIONS='{"rootDir":"."}' npx ts-node src/scripts/vindrosDynamicSignals.ts
 *   TS_NODE_COMPILER_OPTIONS='{"rootDir":"."}' npx ts-node src/scripts/vindrosDynamicSignals.ts --execute
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "../backtest/utils";

const OUTPUT_FILE = path.join(__dirname, "../../vindros_dynamic_signals.txt");
const PORTFOLIO_FILE = path.join(__dirname, "../../vindros_portfolio.json");
const EXECUTE_MODE = process.argv.includes("--execute");

// ─── Configuration (matches vindros_dynamic.ts) ─────────────────────────────
const MIN_POSITIONS = 3;
const MAX_POSITIONS = 15;
const MAX_ADV_FRACTION = 0.1;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const REG_SHORT = 60;
const MIN_PRICE = 10;
const MIN_R2 = 0.6;
const LARGE_MID_MARKETS = [1, 2];
const SMALL_MARKETS = [3, 4, 5];

// Fundamental thresholds (no operating margin for dynamic)
const MIN_REVENUE_GROWTH = 10;
const MIN_REVENUE_MSEK = 50;
const KPI_REVENUE_GROWTH = 94;
const KPI_REVENUE = 53;

type PriceRow = { date: Date; close: number; volume: number };
type Holding = { name: string; shares: number; avgPrice: number };
type Portfolio = {
  holdings: Record<string, Holding>;
  cash: number;
  lastUpdated: string;
  totalDeposited: number;
  startDate: string;
};

const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

// ─── Quality filter (dynamic variant — no margin) ───────────────────────────
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

  const annualKpis = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: instrumentIds },
      kpiId: { in: [KPI_REVENUE_GROWTH, KPI_REVENUE] },
      reportType: "year",
      priceType: "mean",
    },
    select: { instrumentId: true, kpiId: true, year: true, value: true },
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
    if (revGrowthYears.length < 1) continue;
    const recent = revGrowthYears.slice(-5);
    const avgRevGrowth = recent.reduce((s, [, v]) => s + v, 0) / recent.length;
    if (avgRevGrowth < MIN_REVENUE_GROWTH) continue;
    const last4 = revGrowthYears.slice(-4);
    if (last4.filter(([, v]) => v < 0).length > 1) continue;
    // Spike check
    let hasUnvalidatedSpike = false;
    for (let i = 0; i < recent.length; i++) {
      const [yr, v] = recent[i];
      if (v < -30) {
        hasUnvalidatedSpike = true;
        break;
      }
      if (v > 200) {
        const nextEntry = revGrowthYears.find(([y]) => y === yr + 1);
        if (!nextEntry || nextEntry[1] <= 20) {
          hasUnvalidatedSpike = true;
          break;
        }
      }
    }
    if (hasUnvalidatedSpike) continue;

    const revenueMap = kpiMap.get(KPI_REVENUE);
    if (revenueMap) {
      const latest = [...revenueMap.entries()]
        .filter(([y]) => y <= asOfYear)
        .sort((a, b) => a[0] - b[0])
        .pop();
      if (latest && latest[1] < MIN_REVENUE_MSEK) continue;
    }

    annualQualified.add(instId);
  }

  // Quarterly freshness check (revenue growth only, no margin)
  const quarterlyKpis = await prisma.kpiValue.findMany({
    where: {
      instrumentId: { in: [...annualQualified] },
      kpiId: KPI_REVENUE_GROWTH,
      reportType: "quarter",
      priceType: "mean",
    },
    select: {
      instrumentId: true,
      year: true,
      period: true,
      value: true,
    },
  });

  const cutoff = avail.year * 10 + avail.period;
  const qData = new Map<number, Array<{ key: number; value: number }>>();
  for (const kv of quarterlyKpis) {
    if (kv.value === null || kv.period === null) continue;
    const key = kv.year * 10 + kv.period;
    if (key > cutoff) continue;
    if (!qData.has(kv.instrumentId)) qData.set(kv.instrumentId, []);
    qData.get(kv.instrumentId)!.push({ key, value: Number(kv.value) });
  }

  const qualified = new Set<number>();
  for (const instId of annualQualified) {
    const revQ = qData.get(instId);
    if (!revQ || revQ.length === 0) {
      qualified.add(instId);
      continue;
    }
    revQ.sort((a, b) => a.key - b.key);
    if (revQ[revQ.length - 1].value < -10) continue;
    qualified.add(instId);
  }

  return qualified;
}

// ─── Main ────────────────────────────────────────────────────────────────────
const run = async () => {
  const today = new Date().toISOString().slice(0, 10);
  log(`VINDROS DYNAMIC SIGNALS — ${today}`);
  log("═".repeat(70));
  log(`  Strategy: 3-slot concentrated, ADV overflow, A→B substitution`);
  log(
    `  Regression: ${REG_SHORT}-day, R² ≥ ${MIN_R2}, price ≥ ${MIN_PRICE} SEK`,
  );
  log("");

  // Load instruments
  const allDbInstruments = await prisma.instrument.findMany({
    select: { id: true, name: true, marketId: true },
  });
  const nameMap = new Map<number, string>(
    allDbInstruments.map((i) => [i.id, i.name]),
  );

  // Build A→B substitution map
  const aToBMap = new Map<number, number>();
  const bToAMap = new Map<number, number>();
  for (const inst of allDbInstruments) {
    if (inst.name.endsWith(" A")) {
      const bName = inst.name.slice(0, -2) + " B";
      const bInst = allDbInstruments.find((i) => i.name === bName);
      if (bInst) {
        aToBMap.set(inst.id, bInst.id);
        bToAMap.set(bInst.id, inst.id);
      }
    }
  }
  log(`  A→B substitution pairs: ${aToBMap.size}`);

  const largeMidIds = allDbInstruments
    .filter(
      (i) =>
        i.marketId !== null &&
        LARGE_MID_MARKETS.includes(i.marketId) &&
        !bToAMap.has(i.id),
    )
    .map((i) => i.id);
  const smallIds = allDbInstruments
    .filter(
      (i) =>
        i.marketId !== null &&
        SMALL_MARKETS.includes(i.marketId) &&
        !bToAMap.has(i.id),
    )
    .map((i) => i.id);

  const largeMidIdSet = new Set(largeMidIds);
  const allIds = [
    ...new Set([
      ...largeMidIds,
      ...smallIds,
      ...[...aToBMap.values()],
      ...[...bToAMap.values()],
    ]),
  ];

  // Load prices
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 200);

  const allPrices = await prisma.stockPrice.findMany({
    where: { instrumentId: { in: allIds }, date: { gte: startDate } },
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

  const getLatestPrice = (instId: number): number | undefined => {
    const prices = pricesByInstrument.get(instId);
    if (!prices || prices.length === 0) return undefined;
    return prices[prices.length - 1].close;
  };

  const getSlope = (
    instId: number,
  ): { slope: number; r2: number } | undefined => {
    const prices = pricesByInstrument.get(instId);
    if (!prices || prices.length < REG_SHORT) return undefined;
    const lastDate = prices[prices.length - 1].date.toISOString().slice(0, 10);
    const daysDiff =
      (new Date(today).getTime() - new Date(lastDate).getTime()) / 86400000;
    if (daysDiff > 7) return undefined;
    const closes = prices.map((p) => p.close);
    const slice = closes.slice(-REG_SHORT);
    const reg = linearRegression(slice, Math.floor(REG_SHORT * 0.67));
    if (reg.slope <= 0 || reg.r2 < MIN_R2) return undefined;
    return { slope: reg.slope * 252, r2: reg.r2 };
  };

  const getADV = (instId: number): number => {
    const prices = pricesByInstrument.get(instId);
    if (!prices || prices.length < 20) return 0;
    let total = 0;
    for (let i = prices.length - 20; i < prices.length; i++)
      total += prices[i].close * prices[i].volume;
    return total / 20;
  };

  const getEffectiveADV = (
    instId: number,
  ): { adv: number; tradeId: number } => {
    const adv = getADV(instId);
    const bId = aToBMap.get(instId);
    if (bId) {
      const bAdv = getADV(bId);
      if (bAdv > adv) return { adv: bAdv, tradeId: bId };
    }
    return { adv, tradeId: instId };
  };

  // Get quality-filtered small caps
  const qualifiedSmall = await getQualifiedSmallCaps(smallIds);
  log(`  Qualified small caps: ${qualifiedSmall.size}`);

  // Build unified candidate list
  type Candidate = {
    instrumentId: number;
    slope: number;
    r2: number;
    pool: "large" | "small";
  };
  const candidates: Candidate[] = [];

  for (const instId of largeMidIdSet) {
    const price = getLatestPrice(instId);
    if (!price || price < MIN_PRICE) continue;
    const reg = getSlope(instId);
    if (!reg) continue;
    candidates.push({
      instrumentId: instId,
      slope: reg.slope,
      r2: reg.r2,
      pool: "large",
    });
  }
  for (const instId of qualifiedSmall) {
    const price = getLatestPrice(instId);
    if (!price || price < MIN_PRICE) continue;
    const reg = getSlope(instId);
    if (!reg) continue;
    candidates.push({
      instrumentId: instId,
      slope: reg.slope,
      r2: reg.r2,
      pool: "small",
    });
  }
  candidates.sort((a, b) => b.slope - a.slope);

  // Deduplicate A/B shares
  const seenCompanies = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of candidates) {
    const rawName = nameMap.get(c.instrumentId) || "";
    const companyName = rawName.replace(/ [AB]$/, "");
    if (seenCompanies.has(companyName)) continue;
    seenCompanies.add(companyName);
    deduped.push(c);
  }

  log(`  Total candidates (after dedup): ${deduped.length}`);

  // Load portfolio
  let portfolio: Portfolio;
  if (fs.existsSync(PORTFOLIO_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
    portfolio = {
      holdings: raw.holdings ?? {},
      cash: raw.cash ?? 0,
      lastUpdated: raw.lastUpdated ?? "",
      totalDeposited: raw.totalDeposited ?? INITIAL_CAPITAL,
      startDate: raw.startDate ?? raw.lastUpdated ?? today,
    };
  } else {
    portfolio = {
      holdings: {},
      cash: INITIAL_CAPITAL,
      lastUpdated: "",
      totalDeposited: INITIAL_CAPITAL,
      startDate: today,
    };
  }

  // Auto-calculate contributions based on months elapsed
  const startD = new Date(portfolio.startDate || today);
  const nowD = new Date(today);
  const monthsElapsed =
    (nowD.getFullYear() - startD.getFullYear()) * 12 +
    (nowD.getMonth() - startD.getMonth());
  const expectedDeposits =
    INITIAL_CAPITAL + MONTHLY_CONTRIBUTION * Math.max(0, monthsElapsed);
  const newDeposit = expectedDeposits - portfolio.totalDeposited;

  // Calculate current portfolio value
  let portfolioValue = portfolio.cash;
  for (const [name, h] of Object.entries(portfolio.holdings)) {
    const inst = allDbInstruments.find((i) => i.name === name);
    const price = inst ? (getLatestPrice(inst.id) ?? h.avgPrice) : h.avgPrice;
    portfolioValue += h.shares * price;
  }

  if (newDeposit > 0) {
    portfolioValue += newDeposit;
    portfolio.totalDeposited = expectedDeposits;
    log(
      `  Contribution: +${newDeposit.toLocaleString("sv-SE")} SEK (total deposited: ${expectedDeposits.toLocaleString("sv-SE")} SEK)`,
    );
  }

  log(
    `  Portfolio value: ${Math.round(portfolioValue).toLocaleString("sv-SE")} SEK`,
  );

  // ─── Dynamic allocation ─────────────────────────────────────────────────
  const targetPerSlot = portfolioValue / MIN_POSITIONS;
  type Allocation = {
    instrumentId: number;
    tradeId: number;
    slope: number;
    r2: number;
    pool: "large" | "small";
    allocation: number;
    capped: boolean;
  };

  const allocations: Allocation[] = [];
  let remaining = portfolioValue;
  let candidateIdx = 0;
  const usedTradeIds = new Set<number>();

  // Pass 1: allocate up to targetPerSlot each, capping at ADV limit
  while (
    remaining > 100 &&
    candidateIdx < deduped.length &&
    candidateIdx < MAX_POSITIONS
  ) {
    const c = deduped[candidateIdx];
    candidateIdx++;

    const { adv, tradeId } = getEffectiveADV(c.instrumentId);
    if (usedTradeIds.has(tradeId)) continue;
    if (usedTradeIds.has(c.instrumentId)) continue;
    const counterpartId =
      aToBMap.get(c.instrumentId) ?? bToAMap.get(c.instrumentId);
    if (counterpartId && usedTradeIds.has(counterpartId)) continue;

    const maxByLiquidity = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
    const idealAllocation = Math.min(targetPerSlot, remaining);
    const capped = idealAllocation > maxByLiquidity;
    const actualAllocation = Math.min(idealAllocation, maxByLiquidity);

    if (actualAllocation < 100) continue;

    allocations.push({
      instrumentId: c.instrumentId,
      tradeId,
      slope: c.slope,
      r2: c.r2,
      pool: c.pool,
      allocation: actualAllocation,
      capped,
    });

    usedTradeIds.add(tradeId);
    usedTradeIds.add(c.instrumentId);
    if (counterpartId) usedTradeIds.add(counterpartId);
    remaining -= actualAllocation;
  }

  // Pass 2: redistribute leftover
  let passes = 0;
  while (remaining > 100 && passes < 10) {
    passes++;
    const uncapped = allocations.filter((a) => {
      const { adv } = getEffectiveADV(a.instrumentId);
      const maxByLiq = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
      return a.allocation < maxByLiq * 0.99;
    });
    if (uncapped.length === 0) break;
    const perStock = remaining / uncapped.length;
    let distributed = 0;
    for (const a of uncapped) {
      const { adv } = getEffectiveADV(a.instrumentId);
      const maxByLiq = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
      const room = maxByLiq - a.allocation;
      const topUp = Math.min(perStock, room);
      if (topUp > 0) {
        a.allocation += topUp;
        distributed += topUp;
        if (a.allocation >= maxByLiq * 0.99) a.capped = true;
      }
    }
    remaining -= distributed;
  }

  // ─── Output ─────────────────────────────────────────────────────────────
  log("");
  log("═".repeat(70));
  log("TARGET PORTFOLIO");
  log("═".repeat(70));
  log("");
  log(`  Slots: ${allocations.length} (target: ${MIN_POSITIONS})`);
  log("");
  log(
    "  #   Stock                          Price     Slope   Weight   ADV        Alloc      Cap",
  );
  log("  " + "─".repeat(95));

  const targetHoldings = new Map<
    string,
    { shares: number; price: number; allocation: number }
  >();

  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const tradeName = nameMap.get(a.tradeId) || "?";
    const price = getLatestPrice(a.tradeId) || 0;
    const shares = Math.floor(a.allocation / price);
    const weight = ((a.allocation / portfolioValue) * 100).toFixed(1);
    const { adv } = getEffectiveADV(a.instrumentId);
    const advStr =
      adv >= 1e6 ? `${(adv / 1e6).toFixed(1)}M` : `${(adv / 1e3).toFixed(0)}k`;
    const pctOfAdv = adv > 0 ? ((a.allocation / adv) * 100).toFixed(1) : "n/a";
    const capLabel = a.capped ? "◄CAP" : "";
    const poolLabel = a.pool === "small" ? "[S]" : "";

    log(
      `  ${String(i + 1).padStart(2)}  ${(tradeName + " " + poolLabel).padEnd(30)} ${price.toFixed(1).padStart(8)} SEK  ${a.slope.toFixed(2).padStart(6)}  ${weight.padStart(5)}%  ${advStr.padStart(8)} (${pctOfAdv}%)  ${Math.round(a.allocation).toLocaleString("sv-SE").padStart(8)} SEK  ${capLabel}`,
    );

    targetHoldings.set(tradeName, { shares, price, allocation: a.allocation });
  }

  const totalAllocated = allocations.reduce((s, a) => s + a.allocation, 0);
  const cashAfter = portfolioValue - totalAllocated;
  log("  " + "─".repeat(95));
  log(
    `  TOTAL INVESTED: ${Math.round(totalAllocated).toLocaleString("sv-SE")} SEK   CASH: ${Math.round(cashAfter).toLocaleString("sv-SE")} SEK`,
  );

  // ─── Actions: diff against current portfolio ────────────────────────────
  log("");
  log("═".repeat(70));
  log("ACTIONS");
  log("═".repeat(70));
  log("");

  const currentNames = new Set(Object.keys(portfolio.holdings));
  const targetNames = new Set(targetHoldings.keys());

  // SELL
  const sells = [...currentNames].filter((n) => !targetNames.has(n)).sort();
  if (sells.length > 0) {
    log("  SELL (exit entirely):");
    for (const name of sells) {
      const h = portfolio.holdings[name];
      log(`    ✗ ${name.padEnd(28)} sell all ${h.shares} shares`);
    }
    log("");
  }

  // BUY / REBALANCE
  log("  TARGET SHARES:");
  log(
    "  Stock                          Current  Target   Action            ~Cost",
  );
  log("  " + "─".repeat(75));

  for (const [name, target] of [...targetHoldings.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], "sv"),
  )) {
    const currentShares = portfolio.holdings[name]?.shares ?? 0;
    const targetShares = target.shares;
    const diff = targetShares - currentShares;
    let action: string;
    let cost = "";
    if (diff > 0) {
      action = `buy ${diff}`;
      cost = `${Math.round(diff * target.price).toLocaleString("sv-SE")} SEK`;
    } else if (diff < 0) {
      action = `sell ${Math.abs(diff)}`;
      cost = `+${Math.round(Math.abs(diff) * target.price).toLocaleString("sv-SE")} SEK`;
    } else {
      action = "hold";
    }
    log(
      `  ${name.padEnd(30)} ${String(currentShares).padStart(7)}  ${String(targetShares).padStart(6)}   ${action.padEnd(15)}  ${cost}`,
    );
  }
  log("  " + "─".repeat(75));

  // Execute mode
  if (EXECUTE_MODE) {
    const newHoldings: Record<string, Holding> = {};
    for (const [name, target] of targetHoldings) {
      const oldHolding = portfolio.holdings[name];
      const currentShares = oldHolding?.shares ?? 0;
      const currentAvg = oldHolding?.avgPrice ?? target.price;
      let newAvg: number;
      if (currentShares === 0) {
        newAvg = target.price;
      } else if (target.shares > currentShares) {
        const newShares = target.shares - currentShares;
        newAvg =
          (currentShares * currentAvg + newShares * target.price) /
          target.shares;
      } else {
        newAvg = currentAvg;
      }
      newHoldings[name] = {
        name,
        shares: target.shares,
        avgPrice: newAvg,
      };
    }
    const portfolioData: Portfolio = {
      holdings: newHoldings,
      cash: cashAfter,
      lastUpdated: today,
      totalDeposited: portfolio.totalDeposited,
      startDate: portfolio.startDate || today,
    };
    fs.writeFileSync(
      PORTFOLIO_FILE,
      JSON.stringify(portfolioData, null, 2),
      "utf-8",
    );
    log("");
    log(`  ✓ Portfolio saved → ${PORTFOLIO_FILE}`);
  } else {
    log("");
    log(`  → Run with --execute to save portfolio`);
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
