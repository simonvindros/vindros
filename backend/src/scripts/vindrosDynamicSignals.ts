/**
 * VINDROS DYNAMIC SIGNALS — Actionable monthly rebalance for the 3-slot strategy
 *
 * Computes today's target portfolio using the same logic as vindros_dynamic.ts:
 *   - Universe: Large + Mid Cap (markets 1, 2)
 *   - Signal: 60-day linear regression, slope > 0, R² ≥ 0.6
 *   - Rank by slope, 3 target positions, ADV overflow to #4, #5, etc.
 *   - A→B share substitution for liquidity
 *
 * Diffs against vindros_dynamic_portfolio.json and outputs BUY/SELL/HOLD actions.
 *
 * Usage:
 *   npm run vindros:dynamic
 *   npm run vindros:dynamic -- --execute
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

// ─── Configuration (matches vindros_dynamic.ts exactly) ─────────────────────
const MIN_POSITIONS = 3;
const MAX_POSITIONS = 15;
const MAX_ADV_FRACTION = 0.1;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const REG_SHORT = 60;
const MIN_PRICE = 10;
const MIN_R2 = 0.6;
const LARGE_MID_MARKETS = [1, 2];

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

// ─── Main ────────────────────────────────────────────────────────────────────
const run = async () => {
  const today = new Date().toISOString().slice(0, 10);
  log(`VINDROS DYNAMIC SIGNALS — ${today}`);
  log("═".repeat(70));
  log(`  Strategy: 3-slot concentrated, ADV overflow, A→B substitution`);
  log(`  Universe: Large + Mid Cap [${LARGE_MID_MARKETS}]`);
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
  const aShares = allDbInstruments.filter((i) => / A$/.test(i.name));
  for (const a of aShares) {
    const bName = a.name.replace(/ A$/, " B");
    const b = allDbInstruments.find((i) => i.name === bName);
    if (b) {
      aToBMap.set(a.id, b.id);
      bToAMap.set(b.id, a.id);
    }
  }
  log(`  A→B substitution pairs: ${aToBMap.size}`);

  // Universe: Large + Mid only
  const instruments = allDbInstruments.filter(
    (i) => i.marketId !== null && LARGE_MID_MARKETS.includes(i.marketId),
  );
  const allIds = instruments.map((i) => i.id);
  const instrumentIdSet = new Set(allIds);

  // Also need prices for B-shares we might substitute into
  const bShareIds = [...new Set([...aToBMap.values()])];
  const allNeededIds = [...new Set([...allIds, ...bShareIds])];

  // Load last 200 days of prices
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 200);

  const allPrices = await prisma.stockPrice.findMany({
    where: { instrumentId: { in: allNeededIds }, date: { gte: startDate } },
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

  // ─── Helpers (same as vindros_dynamic.ts) ─────────────────────────────────
  const getLatestPrice = (instId: number): number | undefined => {
    const prices = pricesByInstrument.get(instId);
    if (!prices || prices.length === 0) return undefined;
    return prices[prices.length - 1].close;
  };

  const getRegressionScore = (
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

  // ─── Build candidate list (slope-ranked, deduped) ─────────────────────────
  type Candidate = { instrumentId: number; slope: number; r2: number };
  const candidates: Candidate[] = [];

  for (const instId of instrumentIdSet) {
    const price = getLatestPrice(instId);
    if (!price || price < MIN_PRICE) continue;
    const reg = getRegressionScore(instId);
    if (!reg) continue;
    candidates.push({ instrumentId: instId, slope: reg.slope, r2: reg.r2 });
  }
  candidates.sort((a, b) => b.slope - a.slope);

  // Deduplicate by company (strip A/B suffix)
  const seenCompanies = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of candidates) {
    const rawName = nameMap.get(c.instrumentId) || String(c.instrumentId);
    const companyName = rawName.replace(/ [AB]$/, "");
    if (seenCompanies.has(companyName)) continue;
    seenCompanies.add(companyName);
    deduped.push(c);
  }

  log(`  Candidates qualifying: ${deduped.length}`);

  // ─── Load portfolio ─────────────────────────────────────────────────────
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
  for (const [, h] of Object.entries(portfolio.holdings)) {
    const inst = allDbInstruments.find((i) => i.name === h.name);
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

  // ─── Dynamic allocation (matches vindros_dynamic.ts) ──────────────────────
  const targetPerSlot = portfolioValue / MIN_POSITIONS;
  type Allocation = {
    instrumentId: number;
    tradeId: number;
    slope: number;
    r2: number;
    allocation: number;
    capped: boolean;
  };

  const allocations: Allocation[] = [];
  let remaining = portfolioValue;
  let candidateIdx = 0;
  const usedTradeIds = new Set<number>();

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
    if (distributed < 100) break;
  }

  // ─── Output target portfolio ──────────────────────────────────────────────
  log("");
  log("═".repeat(70));
  log("TARGET PORTFOLIO");
  log("═".repeat(70));
  log("");
  log(`  Slots: ${allocations.length} (target: ${MIN_POSITIONS})`);
  log("");
  log(
    "  #   Stock                          Price     Slope    R²    Weight   ADV        Cap",
  );
  log("  " + "─".repeat(90));

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
      adv >= 1e6
        ? `${(adv / 1e6).toFixed(1)}M`
        : `${(adv / 1e3).toFixed(0)}k`;
    const capLabel = a.capped ? "◄CAP" : "";

    log(
      `  ${String(i + 1).padStart(2)}  ${tradeName.padEnd(30)} ${price.toFixed(1).padStart(8)} SEK  ${a.slope.toFixed(2).padStart(6)}  ${a.r2.toFixed(2).padStart(5)}  ${weight.padStart(5)}%  ${advStr.padStart(8)}  ${capLabel}`,
    );

    targetHoldings.set(tradeName, { shares, price, allocation: a.allocation });
  }

  const totalAllocated = allocations.reduce((s, a) => s + a.allocation, 0);
  const cashAfter = portfolioValue - totalAllocated;
  log("  " + "─".repeat(90));
  log(
    `  INVESTED: ${Math.round(totalAllocated).toLocaleString("sv-SE")} SEK   CASH: ${Math.round(cashAfter).toLocaleString("sv-SE")} SEK`,
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

  // TARGET SHARES
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

  // Execute mode: save portfolio
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
