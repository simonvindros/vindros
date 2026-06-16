/**
 * VINDROS US — Pure Momentum on US Stocks
 *
 * Simple: rank all NYSE/Nasdaq stocks by 90-day regression slope.
 * No quality gate (exchange listing requirements handle that).
 * Buy top N, equal weight, rebalance monthly.
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "../lib/prisma";
import { linearRegression } from "./utils";

const OUTPUT_FILE = path.join(__dirname, "vindros_us_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

// ─── Configuration ───────────────────────────────────────────────────────────
const START_DATE = new Date("2006-07-01");
const END_DATE = new Date("2026-06-12");
const TOTAL_POSITIONS = 15;
const INITIAL_CAPITAL = 20_000;
const MONTHLY_CONTRIBUTION = 5_000;
const REG_SHORT = 90;
const MIN_PRICE = 10; // $10 minimum
const MIN_R2 = 0.6;
const MAX_ADV_FRACTION = 0.1;
const MIN_ADV = 50_000_000; // $50M minimum daily dollar volume
const ADV_LOOKBACK = 20;
const SALARY_DAY = 23;

// US Markets (NYSE + Nasdaq, skip OTC)
const US_MARKETS = [29, 32, 33];

// Benchmark: S&P 500 — we'll need to find the right instrument ID
// For now, use the first US index instrument
const BENCHMARK_ID = 0; // Will be resolved below

// ─── Types ───────────────────────────────────────────────────────────────────
type PriceRow = { date: Date; close: number; volume: number };
type Position = {
  instrumentId: number;
  name: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
};
type ClosedTrade = {
  instrumentId: number;
  name: string;
  entryDate: string;
  exitDate: string;
  holdDays: number;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  returnPct: number;
};

// ─── Main ────────────────────────────────────────────────────────────────────
const run = async () => {
  // Find a US index for benchmark
  const usIndex = await prisma.instrument.findFirst({
    where: { countryId: 5, marketId: 28 }, // Market 28 = US Index
    select: { id: true, name: true },
  });

  const benchmarkId = usIndex?.id;
  if (!benchmarkId) {
    log(
      "WARNING: No US index found for benchmark. Using first available US instrument.",
    );
  }
  log(`Benchmark: ${usIndex?.name || "none"} (ID: ${benchmarkId})`);

  // Load all US instruments (NYSE + Nasdaq)
  const instruments = await prisma.instrument.findMany({
    where: { marketId: { in: US_MARKETS }, countryId: 5 },
    select: { id: true, name: true, branchId: true },
  });

  const allIds = instruments.map((i) => i.id);
  const nameMap = new Map<number, string>(
    instruments.map((i) => [i.id, i.name]),
  );
  const branchMap = new Map<number, number | null>(
    instruments.map((i) => [i.id, i.branchId]),
  );

  log(`\nUS Universe: ${instruments.length} stocks (NYSE + Nasdaq)`);
  log(`Total positions: ${TOTAL_POSITIONS}`);
  log(`Regression window: ${REG_SHORT} days`);
  log(`Min R²: ${MIN_R2}`);
  log(`Min price: $${MIN_PRICE}`);
  log("");

  // Load prices — only instruments with sufficient data (>= 90 price rows)
  const warmupDate = new Date(START_DATE);
  warmupDate.setDate(warmupDate.getDate() - 150);

  const idsToLoad = benchmarkId ? [...allIds, benchmarkId] : allIds;

  log("Loading prices (streaming by instrument)...");
  const pricesByInstrument = new Map<number, PriceRow[]>();

  // Load in chunks of 200 instruments to avoid OOM
  const CHUNK_SIZE = 200;
  for (let i = 0; i < idsToLoad.length; i += CHUNK_SIZE) {
    const chunk = idsToLoad.slice(i, i + CHUNK_SIZE);
    const chunkPrices = await prisma.stockPrice.findMany({
      where: {
        instrumentId: { in: chunk },
        date: { gte: warmupDate, lte: END_DATE },
      },
      select: { instrumentId: true, date: true, close: true, volume: true },
      orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    });

    for (const p of chunkPrices) {
      if (!pricesByInstrument.has(p.instrumentId))
        pricesByInstrument.set(p.instrumentId, []);
      pricesByInstrument.get(p.instrumentId)!.push({
        date: p.date,
        close: Number(p.close),
        volume: Number(p.volume),
      });
    }

    if ((i / CHUNK_SIZE) % 5 === 0) {
      process.stdout.write(
        `  ${Math.min(i + CHUNK_SIZE, idsToLoad.length)}/${idsToLoad.length} instruments loaded\r`,
      );
    }
  }

  log(`Loaded prices for ${pricesByInstrument.size} instruments.\n`);

  // Trading days — use the instrument with most data points as calendar reference
  let calendarId = benchmarkId;
  if (!calendarId || !pricesByInstrument.has(calendarId)) {
    // Find the instrument with the most price data
    let maxLen = 0;
    for (const [id, prices] of pricesByInstrument) {
      if (prices.length > maxLen) {
        maxLen = prices.length;
        calendarId = id;
      }
    }
  }

  const calendarPrices = pricesByInstrument.get(calendarId!) || [];
  const tradingDates = calendarPrices
    .filter((p) => p.date >= START_DATE && p.date <= END_DATE)
    .map((p) => p.date.toISOString().slice(0, 10));

  log(
    `Trading days: ${tradingDates.length} (${tradingDates[0]} → ${tradingDates[tradingDates.length - 1]})`,
  );

  // Rebalance = last trading day of month
  const rebalanceDates: string[] = [];
  for (let i = 0; i < tradingDates.length - 1; i++) {
    if (tradingDates[i].slice(0, 7) !== tradingDates[i + 1].slice(0, 7))
      rebalanceDates.push(tradingDates[i]);
  }
  if (tradingDates.length > 0)
    rebalanceDates.push(tradingDates[tradingDates.length - 1]);
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
    for (const d of days) {
      if (d <= cutoff) salaryDate = d;
    }
    salaryDates.add(salaryDate);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  const getPriceOnDate = (
    instId: number,
    dateStr: string,
  ): number | undefined => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return undefined;
    let lo = 0,
      hi = prices.length - 1,
      best: number | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prices[mid].date.toISOString().slice(0, 10) <= dateStr) {
        best = prices[mid].close;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };

  const getPriceIndex = (instId: number, dateStr: string): number => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return -1;
    let lo = 0,
      hi = prices.length - 1,
      best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prices[mid].date.toISOString().slice(0, 10) <= dateStr) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };

  const getRegressionScore = (instId: number, dateStr: string) => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return undefined;
    const idx = getPriceIndex(instId, dateStr);
    if (idx < REG_SHORT) return undefined;

    const lastPriceDate = prices[idx].date.toISOString().slice(0, 10);
    const daysDiff =
      (new Date(dateStr).getTime() - new Date(lastPriceDate).getTime()) /
      86400000;
    if (daysDiff > 7) return undefined;

    const closes = prices.map((p) => p.close);
    const slice = closes.slice(idx - REG_SHORT + 1, idx + 1);
    const reg = linearRegression(slice.length >= 60 ? slice : []);
    if (reg.slope <= 0) return undefined;
    if (reg.r2 < MIN_R2) return undefined;
    return { slope: reg.slope * 252, r2: reg.r2 };
  };

  const getADV = (instId: number, dateStr: string): number => {
    const prices = pricesByInstrument.get(instId);
    if (!prices) return 0;
    const idx = getPriceIndex(instId, dateStr);
    if (idx < ADV_LOOKBACK) return 0;
    let totalTurnover = 0;
    for (let i = idx - ADV_LOOKBACK + 1; i <= idx; i++) {
      totalTurnover += prices[i].close * prices[i].volume;
    }
    return totalTurnover / ADV_LOOKBACK;
  };

  let liquidityFiltered = 0;

  const getTop = (
    dateStr: string,
    count: number,
    estimatedPositionSize: number,
  ) => {
    type Candidate = {
      instrumentId: number;
      slope: number;
      r2: number;
    };
    const candidates: Candidate[] = [];

    for (const inst of instruments) {
      const price = getPriceOnDate(inst.id, dateStr);
      if (!price || price < MIN_PRICE) continue;

      // Liquidity filter: minimum $50M daily dollar volume
      const adv = getADV(inst.id, dateStr);
      if (adv < MIN_ADV) {
        liquidityFiltered++;
        continue;
      }

      const reg = getRegressionScore(inst.id, dateStr);
      if (!reg) continue;

      candidates.push({
        instrumentId: inst.id,
        slope: reg.slope,
        r2: reg.r2,
      });
    }

    // Clenow ranking: slope × R² promotes smooth trends
    candidates.sort((a, b) => b.slope * b.r2 - a.slope * a.r2);
    return candidates.slice(0, count);
  };

  // ─── Backtest ──────────────────────────────────────────────────────────
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let totalContributed = INITIAL_CAPITAL;
  let benchmarkShares = 0;
  if (benchmarkId) {
    const bPrice = getPriceOnDate(benchmarkId, tradingDates[0]);
    if (bPrice) benchmarkShares = INITIAL_CAPITAL / bPrice;
  }
  const closedTrades: ClosedTrade[] = [];
  const dailyValues: { date: string; value: number }[] = [];

  for (const day of tradingDates) {
    // Salary contribution
    if (salaryDates.has(day)) {
      cash += MONTHLY_CONTRIBUTION;
      totalContributed += MONTHLY_CONTRIBUTION;
      if (benchmarkId) {
        const bmPrice = getPriceOnDate(benchmarkId, day);
        if (bmPrice) benchmarkShares += MONTHLY_CONTRIBUTION / bmPrice;
      }
    }

    // Monthly rebalance
    if (rebalanceSet.has(day)) {
      let currentPV = cash;
      for (const pos of positions) {
        const p = getPriceOnDate(pos.instrumentId, day) || pos.entryPrice;
        currentPV += pos.shares * p;
      }
      const estPositionSize = currentPV / TOTAL_POSITIONS;

      const topCandidates = getTop(day, TOTAL_POSITIONS, estPositionSize);
      const allCandidateIds = new Set(topCandidates.map((c) => c.instrumentId));

      // Sell positions not in new targets
      const keepPositions: Position[] = [];
      for (const pos of positions) {
        if (allCandidateIds.has(pos.instrumentId)) {
          keepPositions.push(pos);
        } else {
          const price = getPriceOnDate(pos.instrumentId, day);
          if (price) {
            cash += price * pos.shares;
            const holdDays = Math.round(
              (new Date(day).getTime() - new Date(pos.entryDate).getTime()) /
                86400000,
            );
            closedTrades.push({
              instrumentId: pos.instrumentId,
              name: nameMap.get(pos.instrumentId) || "",
              entryDate: pos.entryDate,
              exitDate: day,
              holdDays,
              entryPrice: pos.entryPrice,
              exitPrice: price,
              shares: pos.shares,
              pnl: (price - pos.entryPrice) * pos.shares,
              returnPct: (price / pos.entryPrice - 1) * 100,
            });
          }
        }
      }
      positions = keepPositions;

      // Rebalance to equal weight
      const totalSlots = topCandidates.length;
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
          const sellShares = Math.floor(
            (currentValue - targetPerStock) / price,
          );
          if (sellShares > 0) {
            cash += sellShares * price;
            pos.shares -= sellShares;
          }
        }
      }

      // Top up underweight
      for (const pos of positions) {
        const price = getPriceOnDate(pos.instrumentId, day);
        if (!price) continue;
        const currentValue = pos.shares * price;
        if (currentValue < targetPerStock * 0.99) {
          const buyShares = Math.floor((targetPerStock - currentValue) / price);
          if (buyShares > 0 && cash >= buyShares * price) {
            cash -= buyShares * price;
            pos.shares += buyShares;
          }
        }
      }

      // Buy new entries
      const heldIds = new Set(positions.map((p) => p.instrumentId));
      for (const c of topCandidates) {
        if (heldIds.has(c.instrumentId)) continue;
        const price = getPriceOnDate(c.instrumentId, day);
        if (!price) continue;
        const shares = Math.floor(Math.min(targetPerStock, cash) / price);
        if (shares === 0) continue;
        positions.push({
          instrumentId: c.instrumentId,
          name: nameMap.get(c.instrumentId) || "",
          entryDate: day,
          entryPrice: price,
          shares,
        });
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
    const holdDays = Math.round(
      (new Date(lastDate).getTime() - new Date(pos.entryDate).getTime()) /
        86400000,
    );
    closedTrades.push({
      instrumentId: pos.instrumentId,
      name: nameMap.get(pos.instrumentId) || "",
      entryDate: pos.entryDate,
      exitDate: lastDate,
      holdDays,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      shares: pos.shares,
      pnl: (price - pos.entryPrice) * pos.shares,
      returnPct: (price / pos.entryPrice - 1) * 100,
    });
    cash += price * pos.shares;
  }

  // ─── Results ───────────────────────────────────────────────────────────
  const finalValue = cash;
  const totalReturn = (finalValue / totalContributed - 1) * 100;
  const benchFinal = benchmarkId
    ? benchmarkShares * (getPriceOnDate(benchmarkId, lastDate) || 0)
    : 0;
  const benchReturn = benchmarkId
    ? (benchFinal / totalContributed - 1) * 100
    : 0;
  const alpha = totalReturn - benchReturn;

  let peak = 0,
    maxDrawdown = 0;
  for (const { value } of dailyValues) {
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const winners = closedTrades.filter((t) => t.pnl > 0);
  const losers = closedTrades.filter((t) => t.pnl <= 0);
  const grossWins = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const fmtUSD = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

  log("");
  log("═".repeat(80));
  log("VINDROS US — Pure Momentum (NYSE + Nasdaq)");
  log("═".repeat(80));
  log("");
  log("RULES:");
  log(`  • Universe: ${instruments.length} US stocks (NYSE + Nasdaq)`);
  log(`  • ${TOTAL_POSITIONS} positions, ranked by 90d slope×R², equal weight`);
  log(
    `  • Min price: $${MIN_PRICE} | Min R²: ${MIN_R2} | Min ADV: $${(MIN_ADV / 1e6).toFixed(0)}M`,
  );
  log(`  • Monthly rebalance (last trading day)`);
  log(`  • Contribution: ${MONTHLY_CONTRIBUTION.toLocaleString()}/month`);
  log(`  • Liquidity filtered: ${liquidityFiltered} times`);
  log("");
  log("PERFORMANCE:");
  log(`  Total contributed: ${fmtUSD(totalContributed)}`);
  log(`  Final value:       ${fmtUSD(finalValue)}`);
  log(`  Return:            ${fmtPct(totalReturn)}`);
  if (benchmarkId) {
    log(`  Benchmark:         ${fmtPct(benchReturn)} (${usIndex?.name})`);
    log(`  ALPHA:             ${fmtPct(alpha)}`);
  }
  log("");
  log("DRAWDOWN:");
  log(`  Max drawdown:      ${(maxDrawdown * 100).toFixed(1)}%`);
  log("");
  log("TRADE STATISTICS:");
  log(`  Total trades:      ${closedTrades.length}`);
  log(
    `  Winners:           ${winners.length} (${((winners.length / closedTrades.length) * 100).toFixed(1)}%)`,
  );
  log(`  Profit factor:     ${profitFactor.toFixed(2)}`);
  log(
    `  Avg win:           ${fmtPct(winners.length ? winners.reduce((s, t) => s + t.returnPct, 0) / winners.length : 0)}`,
  );
  log(
    `  Avg loss:          ${fmtPct(losers.length ? losers.reduce((s, t) => s + t.returnPct, 0) / losers.length : 0)}`,
  );
  log(
    `  Avg hold (days):   ${Math.round(closedTrades.reduce((s, t) => s + t.holdDays, 0) / closedTrades.length)}`,
  );

  // ─── Current Holdings ──────────────────────────────────────────────────
  const today = tradingDates[tradingDates.length - 1];
  const latestTop = getTop(
    today,
    TOTAL_POSITIONS,
    finalValue / TOTAL_POSITIONS,
  );

  log("");
  log("═".repeat(80));
  log(`CURRENT TOP ${TOTAL_POSITIONS} — ${today}`);
  log("═".repeat(80));
  log("");
  for (let i = 0; i < latestTop.length; i++) {
    const c = latestTop[i];
    const price = getPriceOnDate(c.instrumentId, today);
    log(
      `  ${String(i + 1).padStart(2)}. ${(nameMap.get(c.instrumentId) || "").padEnd(30)} slope: ${c.slope.toFixed(2).padStart(6)}  R²: ${c.r2.toFixed(2)}  price: $${price?.toFixed(2)}`,
    );
  }

  // ─── Branch analysis ───────────────────────────────────────────────────
  log("");
  log("BRANCH CONCENTRATION:");
  const branchCount = new Map<number, number>();
  for (const c of latestTop) {
    const b = branchMap.get(c.instrumentId);
    if (b) branchCount.set(b, (branchCount.get(b) || 0) + 1);
  }
  const branches = await prisma.branch.findMany();
  const branchNameMap = new Map(branches.map((b) => [b.branchId, b.name]));
  const sortedBranches = [...branchCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [branchId, count] of sortedBranches) {
    log(
      `  ${branchNameMap.get(branchId) || `Branch ${branchId}`}: ${count} stocks`,
    );
  }

  // ─── Biggest Winners / Losers ──────────────────────────────────────────
  log("");
  log("═".repeat(80));
  log("TOP 20 BIGGEST WINNING TRADES (by return %)");
  log("═".repeat(80));
  log("");
  const sortedByReturn = [...closedTrades].sort(
    (a, b) => b.returnPct - a.returnPct,
  );
  for (const t of sortedByReturn.slice(0, 20)) {
    log(
      `  ${t.name.padEnd(30)} ${fmtPct(t.returnPct).padStart(8)}  held ${t.holdDays}d  (${t.entryDate} → ${t.exitDate})  PnL: ${fmtUSD(t.pnl)}`,
    );
  }

  log("");
  log("TOP 10 BIGGEST LOSING TRADES (by return %)");
  log("");
  const sortedByLoss = [...closedTrades].sort(
    (a, b) => a.returnPct - b.returnPct,
  );
  for (const t of sortedByLoss.slice(0, 10)) {
    log(
      `  ${t.name.padEnd(30)} ${fmtPct(t.returnPct).padStart(8)}  held ${t.holdDays}d  (${t.entryDate} → ${t.exitDate})  PnL: ${fmtUSD(t.pnl)}`,
    );
  }

  // ─── Notable Stock Tracker ─────────────────────────────────────────────
  log("");
  log("═".repeat(80));
  log("AI / NOTABLE STOCK TRACKER — Did we catch these?");
  log("═".repeat(80));
  log("");
  const notableStocks = [
    "NVDA",
    "AMD",
    "MU",
    "SMCI",
    "PLTR",
    "AVGO",
    "SNDK",
    "MSTR",
    "TSLA",
    "COIN",
  ];
  for (const ticker of notableStocks) {
    const inst = instruments.find(
      (i) => i.name.includes(ticker) || nameMap.get(i.id)?.includes(ticker),
    );
    // Find by ticker in DB
    const dbInst = await prisma.instrument.findFirst({
      where: { ticker, countryId: 5 },
      select: { id: true, name: true },
    });
    if (!dbInst) {
      log(`  ${ticker.padEnd(6)} — not in database`);
      continue;
    }
    const trades = closedTrades.filter((t) => t.instrumentId === dbInst.id);
    if (trades.length === 0) {
      log(`  ${ticker.padEnd(6)} (${dbInst.name}) — NEVER HELD`);
    } else {
      const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
      const bestTrade = trades.reduce(
        (best, t) => (t.returnPct > best.returnPct ? t : best),
        trades[0],
      );
      const totalHoldDays = trades.reduce((s, t) => s + t.holdDays, 0);
      log(`  ${ticker.padEnd(6)} (${dbInst.name})`);
      log(
        `         ${trades.length} trades | Total PnL: ${fmtUSD(totalPnl)} | Total days held: ${totalHoldDays}`,
      );
      log(
        `         Best trade: ${fmtPct(bestTrade.returnPct)} in ${bestTrade.holdDays}d (${bestTrade.entryDate} → ${bestTrade.exitDate})`,
      );
    }
  }

  // Write output
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"));
  log(`\nOutput written to ${OUTPUT_FILE}`);

  await prisma.$disconnect();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
