/**
 * STOCK ATTRIBUTION — Which individual stocks drove the +4,227% return?
 *
 * Runs the full dynamic backtest and tracks per-stock profit/loss.
 * Output: ranked list of stock contributions + "what if we removed top N" analysis.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadEngineData,
  getPriceOnDate,
  getEffectiveADV,
  getAllCandidates,
  allocatePositions,
  getQualifiedSmallCaps,
  latestAvailableQuarter,
  disconnect,
  INITIAL_CAPITAL,
  MONTHLY_CONTRIBUTION,
  BENCHMARK_ID,
  MIN_POSITIONS,
  START_DATE,
  END_DATE,
  Position,
  EngineData,
} from "./engine";

const OUTPUT_FILE = path.join(__dirname, "stock_attribution_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

// ─── Per-stock tracking ──────────────────────────────────────────────────────
type TradeRecord = {
  instrumentId: number;
  tradeId: number;
  name: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number; // absolute SEK profit/loss
  pctOfPortfolio: number; // pnl as % of portfolio value at exit
  holdingMonths: number;
};

const allTrades: TradeRecord[] = [];

const run = async () => {
  log("Loading data...");
  const data = await loadEngineData();
  log(
    `Loaded ${data.tradingDates.length} trading days, ${data.allIds.length} instruments`,
  );

  // ─── Backtest Loop (mirrors vindros_dynamic.ts) ────────────────────────
  let cash = INITIAL_CAPITAL;
  let positions: Position[] = [];
  let totalContributed = INITIAL_CAPITAL;
  let benchmarkShares =
    INITIAL_CAPITAL /
    (getPriceOnDate(
      data.pricesByInstrument,
      BENCHMARK_ID,
      data.tradingDates[0],
    ) || 1);

  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyYear = 0;
  let monthCount = 0;

  for (const day of data.tradingDates) {
    if (data.salaryDates.has(day)) {
      cash += MONTHLY_CONTRIBUTION;
      totalContributed += MONTHLY_CONTRIBUTION;
      const bmPrice = getPriceOnDate(
        data.pricesByInstrument,
        BENCHMARK_ID,
        day,
      );
      if (bmPrice) benchmarkShares += MONTHLY_CONTRIBUTION / bmPrice;
    }

    const currentYear = parseInt(day.slice(0, 4));
    const currentMonth = parseInt(day.slice(5, 7));
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

    if (data.monthEndSet.has(day)) {
      monthCount++;

      // Portfolio value
      let currentPV = cash;
      for (const pos of positions) {
        const p =
          getPriceOnDate(data.pricesByInstrument, pos.tradeId, day) ||
          pos.entryPrice;
        currentPV += pos.shares * p;
      }

      // Allocate
      const allCandidates = getAllCandidates(data, day, qualifiedSmallCaps);
      const { allocations } = allocatePositions(
        data,
        allCandidates,
        currentPV,
        day,
      );
      const allSelectedSignalIds = new Set(
        allocations.map((a) => a.instrumentId),
      );

      // Sell positions not in new allocation
      const keepPositions: Position[] = [];
      for (const pos of positions) {
        if (allSelectedSignalIds.has(pos.instrumentId)) {
          keepPositions.push(pos);
        } else {
          const price = getPriceOnDate(
            data.pricesByInstrument,
            pos.tradeId,
            day,
          );
          if (price) {
            const pnl = (price - pos.entryPrice) * pos.shares;
            const entryMonth = parseInt(pos.entryDate.slice(5, 7));
            const entryYear = parseInt(pos.entryDate.slice(0, 4));
            const holdingMonths =
              (currentYear - entryYear) * 12 + (currentMonth - entryMonth);
            allTrades.push({
              instrumentId: pos.instrumentId,
              tradeId: pos.tradeId,
              name: pos.name,
              entryDate: pos.entryDate,
              exitDate: day,
              entryPrice: pos.entryPrice,
              exitPrice: price,
              shares: pos.shares,
              pnl,
              pctOfPortfolio: currentPV > 0 ? (pnl / currentPV) * 100 : 0,
              holdingMonths,
            });
            cash += price * pos.shares;
          }
        }
      }
      positions = keepPositions;

      // Rebalance existing
      const allocationMap = new Map(
        allocations.map((a) => [a.instrumentId, a]),
      );
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
            // Record partial sell as a trade
            const pnl = (price - pos.entryPrice) * sellShares;
            allTrades.push({
              instrumentId: pos.instrumentId,
              tradeId: pos.tradeId,
              name: pos.name,
              entryDate: pos.entryDate,
              exitDate: day,
              entryPrice: pos.entryPrice,
              exitPrice: price,
              shares: sellShares,
              pnl,
              pctOfPortfolio: currentPV > 0 ? (pnl / currentPV) * 100 : 0,
              holdingMonths: 0, // partial
            });
            cash += sellShares * price;
            pos.shares -= sellShares;
          }
        } else if (currentValue < target * 0.99) {
          const buyShares = Math.floor((target - currentValue) / price);
          if (buyShares > 0 && cash >= buyShares * price) {
            cash -= buyShares * price;
            pos.shares += buyShares;
            // Update entry price to weighted average
            // (simplified: keep original entry for attribution purposes)
          }
        }
      }

      // Buy new entries
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
  }

  // Close remaining positions at final date
  const lastDate = data.tradingDates[data.tradingDates.length - 1];
  let closingPV = cash;
  for (const pos of positions) {
    const p = getPriceOnDate(data.pricesByInstrument, pos.tradeId, lastDate);
    closingPV += pos.shares * (p || pos.entryPrice);
  }
  for (const pos of positions) {
    const price = getPriceOnDate(
      data.pricesByInstrument,
      pos.tradeId,
      lastDate,
    );
    if (price) {
      const pnl = (price - pos.entryPrice) * pos.shares;
      allTrades.push({
        instrumentId: pos.instrumentId,
        tradeId: pos.tradeId,
        name: pos.name,
        entryDate: pos.entryDate,
        exitDate: lastDate,
        entryPrice: pos.entryPrice,
        exitPrice: price,
        shares: pos.shares,
        pnl,
        pctOfPortfolio: closingPV > 0 ? (pnl / closingPV) * 100 : 0,
        holdingMonths: 0,
      });
    }
  }

  // ─── Attribution Analysis ──────────────────────────────────────────────
  // Aggregate by company (strip A/B suffix)
  const byCompany = new Map<
    string,
    {
      totalPnl: number;
      totalPctContrib: number;
      tradeCount: number;
      wins: number;
      losses: number;
      biggestWin: number;
      biggestLoss: number;
      biggestWinPct: number;
      biggestLossPct: number;
    }
  >();

  for (const t of allTrades) {
    const company = t.name.replace(/ [AB]$/, "") || `ID:${t.instrumentId}`;
    if (!byCompany.has(company)) {
      byCompany.set(company, {
        totalPnl: 0,
        totalPctContrib: 0,
        tradeCount: 0,
        wins: 0,
        losses: 0,
        biggestWin: 0,
        biggestLoss: 0,
        biggestWinPct: 0,
        biggestLossPct: 0,
      });
    }
    const entry = byCompany.get(company)!;
    entry.totalPnl += t.pnl;
    entry.totalPctContrib += t.pctOfPortfolio;
    entry.tradeCount++;
    if (t.pnl > 0) {
      entry.wins++;
      if (t.pnl > entry.biggestWin) entry.biggestWin = t.pnl;
      if (t.pctOfPortfolio > entry.biggestWinPct)
        entry.biggestWinPct = t.pctOfPortfolio;
    } else {
      entry.losses++;
      if (t.pnl < entry.biggestLoss) entry.biggestLoss = t.pnl;
      if (t.pctOfPortfolio < entry.biggestLossPct)
        entry.biggestLossPct = t.pctOfPortfolio;
    }
  }

  const sorted = [...byCompany.entries()].sort(
    (a, b) => b[1].totalPnl - a[1].totalPnl,
  );
  const totalPnl = sorted.reduce((sum, [, v]) => sum + v.totalPnl, 0);

  // Final portfolio value
  let finalValue = cash;
  const lastDay = data.tradingDates[data.tradingDates.length - 1];
  const bmFinal =
    benchmarkShares *
    (getPriceOnDate(data.pricesByInstrument, BENCHMARK_ID, lastDay) || 0);

  log("");
  log("═".repeat(90));
  log("STOCK ATTRIBUTION — VINDROS DYNAMIC");
  log("═".repeat(90));
  log(
    `Total P&L from trades: ${Math.round(totalPnl).toLocaleString("sv-SE")} SEK`,
  );
  log(`Total contributed: ${totalContributed.toLocaleString("sv-SE")} SEK`);
  log(`Unique companies traded: ${byCompany.size}`);
  log(`Total individual trades: ${allTrades.length}`);
  log("");

  // Top 30 contributors
  log("─".repeat(90));
  log("TOP 30 CONTRIBUTORS (by total P&L)");
  log("─".repeat(90));
  log(
    `${"#".padStart(3)}  ${"Company".padEnd(35)} ${"Total P&L".padStart(14)} ${"% of Total".padStart(10)} ${"Trades".padStart(7)} ${"W/L".padStart(7)} ${"Biggest Win".padStart(14)}`,
  );
  log("─".repeat(90));

  let cumulativePct = 0;
  for (let i = 0; i < Math.min(30, sorted.length); i++) {
    const [name, stats] = sorted[i];
    const pctOfTotal = (stats.totalPnl / totalPnl) * 100;
    cumulativePct += pctOfTotal;
    log(
      `${String(i + 1).padStart(3)}  ${name.padEnd(35)} ${Math.round(stats.totalPnl).toLocaleString("sv-SE").padStart(14)} ${pctOfTotal.toFixed(1).padStart(9)}% ${String(stats.tradeCount).padStart(7)} ${`${stats.wins}/${stats.losses}`.padStart(7)} ${Math.round(stats.biggestWin).toLocaleString("sv-SE").padStart(14)}`,
    );
  }
  log("─".repeat(90));
  log(`Top 30 cumulative: ${cumulativePct.toFixed(1)}% of total P&L`);

  // Bottom 20 (worst performers)
  log("");
  log("─".repeat(90));
  log("BOTTOM 20 (worst contributors)");
  log("─".repeat(90));
  const bottom = sorted.slice(-20).reverse();
  for (let i = 0; i < bottom.length; i++) {
    const [name, stats] = bottom[i];
    const pctOfTotal = (stats.totalPnl / totalPnl) * 100;
    log(
      `${String(i + 1).padStart(3)}  ${name.padEnd(35)} ${Math.round(stats.totalPnl).toLocaleString("sv-SE").padStart(14)} ${pctOfTotal.toFixed(1).padStart(9)}% ${String(stats.tradeCount).padStart(7)} ${`${stats.wins}/${stats.losses}`.padStart(7)} ${Math.round(stats.biggestLoss).toLocaleString("sv-SE").padStart(14)}`,
    );
  }

  // ─── "What if we removed top N?" analysis ──────────────────────────────
  log("");
  log("─".repeat(90));
  log("CONCENTRATION RISK — WHAT IF TOP CONTRIBUTORS DIDN'T EXIST?");
  log("─".repeat(90));
  log(
    `${"Removed".padStart(10)} ${"Remaining P&L".padStart(16)} ${"% of Original".padStart(14)} ${"Still beats BM?".padStart(16)}`,
  );
  log("─".repeat(90));

  const bmReturn = (bmFinal / totalContributed - 1) * 100;
  const fullReturn =
    ((totalContributed + totalPnl) / totalContributed - 1) * 100;

  for (const n of [1, 2, 3, 5, 10, 15, 20]) {
    const removedPnl = sorted
      .slice(0, n)
      .reduce((s, [, v]) => s + v.totalPnl, 0);
    const remainingPnl = totalPnl - removedPnl;
    const remainingReturn =
      ((totalContributed + remainingPnl) / totalContributed - 1) * 100;
    const pctOfOriginal = (remainingPnl / totalPnl) * 100;
    const beatsBm = remainingReturn > bmReturn ? "YES" : "NO";
    log(
      `${`Top ${n}`.padStart(10)} ${Math.round(remainingPnl).toLocaleString("sv-SE").padStart(16)} ${pctOfOriginal.toFixed(1).padStart(13)}% ${`${beatsBm} (${remainingReturn.toFixed(0)}% vs ${bmReturn.toFixed(0)}%)`.padStart(16)}`,
    );
  }

  // ─── Normalized (percentage) ranking ────────────────────────────────────
  // Ranks companies by sum of (pnl / portfolioValue) across all trades.
  // This normalizes for portfolio size — a 20% gain on a 50k portfolio
  // and a 20% gain on a 40M portfolio both count as +20pp.
  const sortedByPct = [...byCompany.entries()].sort(
    (a, b) => b[1].totalPctContrib - a[1].totalPctContrib,
  );
  const totalPctContrib = sortedByPct.reduce(
    (s, [, v]) => s + v.totalPctContrib,
    0,
  );

  log("");
  log("─".repeat(100));
  log("TOP 30 CONTRIBUTORS — NORMALIZED (% of portfolio at time of trade)");
  log("─".repeat(100));
  log(
    `${"#".padStart(3)}  ${"Company".padEnd(35)} ${"Sum of %pp".padStart(12)} ${"% of Total".padStart(10)} ${"Trades".padStart(7)} ${"W/L".padStart(7)} ${"Best Trade".padStart(11)}`,
  );
  log("─".repeat(100));

  let cumPctNorm = 0;
  for (let i = 0; i < Math.min(30, sortedByPct.length); i++) {
    const [name, stats] = sortedByPct[i];
    const pctOfTotal =
      totalPctContrib !== 0
        ? (stats.totalPctContrib / totalPctContrib) * 100
        : 0;
    cumPctNorm += pctOfTotal;
    log(
      `${String(i + 1).padStart(3)}  ${name.padEnd(35)} ${stats.totalPctContrib.toFixed(1).padStart(11)}% ${pctOfTotal.toFixed(1).padStart(9)}% ${String(stats.tradeCount).padStart(7)} ${`${stats.wins}/${stats.losses}`.padStart(7)} ${`+${stats.biggestWinPct.toFixed(1)}%`.padStart(11)}`,
    );
  }
  log("─".repeat(100));
  log(`Top 30 cumulative: ${cumPctNorm.toFixed(1)}% of total normalized P&L`);

  // Bottom 20 normalized
  log("");
  log("─".repeat(100));
  log("BOTTOM 20 — NORMALIZED");
  log("─".repeat(100));
  const bottomPct = sortedByPct.slice(-20).reverse();
  for (let i = 0; i < bottomPct.length; i++) {
    const [name, stats] = bottomPct[i];
    const pctOfTotal =
      totalPctContrib !== 0
        ? (stats.totalPctContrib / totalPctContrib) * 100
        : 0;
    log(
      `${String(i + 1).padStart(3)}  ${name.padEnd(35)} ${stats.totalPctContrib.toFixed(1).padStart(11)}% ${pctOfTotal.toFixed(1).padStart(9)}% ${String(stats.tradeCount).padStart(7)} ${`${stats.wins}/${stats.losses}`.padStart(7)} ${`${stats.biggestLossPct.toFixed(1)}%`.padStart(11)}`,
    );
  }

  // ─── Year-by-year top contributor (normalized) ─────────────────────────
  log("");
  log("─".repeat(100));
  log("TOP CONTRIBUTOR BY YEAR — NORMALIZED (% of portfolio impact)");
  log("─".repeat(100));

  const tradesByYearNorm = new Map<number, TradeRecord[]>();
  for (const t of allTrades) {
    const year = parseInt(t.exitDate.slice(0, 4));
    if (!tradesByYearNorm.has(year)) tradesByYearNorm.set(year, []);
    tradesByYearNorm.get(year)!.push(t);
  }

  for (const [year, trades] of [...tradesByYearNorm.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const byCoYear = new Map<string, number>();
    for (const t of trades) {
      const co = t.name.replace(/ [AB]$/, "") || `ID:${t.instrumentId}`;
      byCoYear.set(co, (byCoYear.get(co) || 0) + t.pctOfPortfolio);
    }
    const topEntry = [...byCoYear.entries()].sort((a, b) => b[1] - a[1])[0];
    const yearTotalPct = trades.reduce((s, t) => s + t.pctOfPortfolio, 0);
    if (topEntry) {
      const pctOfYear =
        yearTotalPct !== 0
          ? ((topEntry[1] / yearTotalPct) * 100).toFixed(0)
          : "N/A";
      log(
        `  ${year}: ${topEntry[0].padEnd(30)} ${topEntry[1] >= 0 ? "+" : ""}${topEntry[1].toFixed(1)}%  (${pctOfYear}% of year's normalized P&L)`,
      );
    }
  }

  // ─── Holding period analysis ───────────────────────────────────────────
  log("");
  log("─".repeat(90));
  log("TRADE STATISTICS");
  log("─".repeat(90));

  const winningTrades = allTrades.filter((t) => t.pnl > 0);
  const losingTrades = allTrades.filter((t) => t.pnl < 0);
  const avgWin =
    winningTrades.length > 0
      ? winningTrades.reduce((s, t) => s + t.pnl, 0) / winningTrades.length
      : 0;
  const avgLoss =
    losingTrades.length > 0
      ? losingTrades.reduce((s, t) => s + t.pnl, 0) / losingTrades.length
      : 0;

  log(`  Total trades:     ${allTrades.length}`);
  log(
    `  Winning trades:   ${winningTrades.length} (${((winningTrades.length / allTrades.length) * 100).toFixed(1)}%)`,
  );
  log(
    `  Losing trades:    ${losingTrades.length} (${((losingTrades.length / allTrades.length) * 100).toFixed(1)}%)`,
  );
  log(`  Avg winning trade: ${Math.round(avgWin).toLocaleString("sv-SE")} SEK`);
  log(
    `  Avg losing trade:  ${Math.round(avgLoss).toLocaleString("sv-SE")} SEK`,
  );
  log(`  Win/Loss ratio:    ${Math.abs(avgWin / avgLoss).toFixed(2)}x`);
  log(
    `  Expectancy:        ${Math.round((winningTrades.length / allTrades.length) * avgWin + (losingTrades.length / allTrades.length) * avgLoss).toLocaleString("sv-SE")} SEK/trade`,
  );

  // ─── Year-by-year top contributor ──────────────────────────────────────
  log("");
  log("─".repeat(90));
  log("TOP CONTRIBUTOR BY YEAR");
  log("─".repeat(90));

  const tradesByYear = new Map<number, TradeRecord[]>();
  for (const t of allTrades) {
    const year = parseInt(t.exitDate.slice(0, 4));
    if (!tradesByYear.has(year)) tradesByYear.set(year, []);
    tradesByYear.get(year)!.push(t);
  }

  for (const [year, trades] of [...tradesByYear.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const byCoYear = new Map<string, number>();
    for (const t of trades) {
      const co = t.name.replace(/ [AB]$/, "") || `ID:${t.instrumentId}`;
      byCoYear.set(co, (byCoYear.get(co) || 0) + t.pnl);
    }
    const topEntry = [...byCoYear.entries()].sort((a, b) => b[1] - a[1])[0];
    const yearPnl = trades.reduce((s, t) => s + t.pnl, 0);
    if (topEntry) {
      const pctOfYear =
        yearPnl !== 0 ? ((topEntry[1] / yearPnl) * 100).toFixed(0) : "N/A";
      log(
        `  ${year}: ${topEntry[0].padEnd(30)} ${Math.round(topEntry[1]).toLocaleString("sv-SE").padStart(12)} SEK (${pctOfYear}% of year's P&L)`,
      );
    }
  }

  log("");
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`Output: ${OUTPUT_FILE}`);
  await disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
