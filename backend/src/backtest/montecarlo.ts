import "dotenv/config";
/**
 * Monte Carlo Simulation for Vindros Strategy
 *
 * Takes the closed trades from the backtest, shuffles their order thousands
 * of times, and computes equity curves to determine:
 * - Confidence interval on total return
 * - Distribution of max drawdowns
 * - Probability of ruin
 * - Whether the result is statistically significant
 */

// ─── Config ──────────────────────────────────────────────────────────────────
const SIMULATIONS = 10_000;
const INITIAL_CAPITAL = 50_000;
const MONTHLY_CONTRIBUTION = 5_000;
const TOTAL_POSITIONS = 15;

// ─── Types ───────────────────────────────────────────────────────────────────
type Trade = {
  returnPct: number;
  holdDays: number;
};

// ─── Helper: Fisher-Yates shuffle ────────────────────────────────────────────
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Helper: Percentile ──────────────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── Simulate one equity curve from shuffled trades ──────────────────────────
function simulateEquityCurve(
  trades: Trade[],
  totalMonths: number,
): { finalValue: number; maxDrawdown: number } {
  // Distribute trades evenly across months (same avg trades/month as real)
  const tradesPerMonth = trades.length / totalMonths;

  let equity = INITIAL_CAPITAL;
  let peak = equity;
  let maxDrawdown = 0;
  let tradeIdx = 0;

  for (let month = 0; month < totalMonths; month++) {
    // Monthly contribution
    if (month > 0) equity += MONTHLY_CONTRIBUTION;

    // Apply trades for this month
    const tradesThisMonth = Math.round(tradesPerMonth);
    for (let t = 0; t < tradesThisMonth && tradeIdx < trades.length; t++) {
      const trade = trades[tradeIdx++];
      // Each position is 1/TOTAL_POSITIONS of portfolio
      const positionSize = equity / TOTAL_POSITIONS;
      const pnl = positionSize * (trade.returnPct / 100);
      equity += pnl;

      // Drawdown tracking
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Update peak after contribution
    if (equity > peak) peak = equity;
  }

  return { finalValue: equity, maxDrawdown };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Import the real backtest trades
  // We'll run the actual backtest to get the trades, or load from output
  // For efficiency, let's just define the trade data inline from backtest results

  const { prisma } = await import("../lib/prisma");

  // Run a minimal version of the backtest to extract trades
  // Instead, let's read from the analysis output or re-run
  // Actually — let's import and run vindros_final to get the trades

  // Better approach: extract trade returns from the existing backtest
  // For now, let's read the output file and parse trade data
  const fs = await import("fs");
  const path = await import("path");

  const outputFile = path.join(__dirname, "vindros_analysis_output.txt");
  if (!fs.existsSync(outputFile)) {
    console.error("Run vindros:analysis first to generate trade data.");
    process.exit(1);
  }

  const content = fs.readFileSync(outputFile, "utf-8");
  const lines = content.split("\n");

  // Parse exit lines: "    ✗ Name [pool]  +12.3% — reason"
  const trades: Trade[] = [];
  const exitRegex = /✗\s+.+?\s+\[(?:large|small)\]\s+([+-]?\d+\.?\d*)%/;

  for (const line of lines) {
    const match = line.match(exitRegex);
    if (match) {
      trades.push({
        returnPct: parseFloat(match[1]),
        holdDays: 30, // approximate, used for grouping only
      });
    }
  }

  // Also extract total months from the summary
  const monthsMatch = content.match(/Months:\s+(\d+)/);
  const totalMonths = monthsMatch ? parseInt(monthsMatch[1]) : 239;

  // Extract actual final values for comparison
  const returnMatch = content.match(/Return:\s+\+?([-\d.]+)%/);
  const actualReturn = returnMatch ? parseFloat(returnMatch[1]) : 0;
  const contribMatch = content.match(/Contributed:\s+([\d\s]+)\s*SEK/);
  const totalContributed = contribMatch
    ? parseInt(contribMatch[1].replace(/\s/g, ""))
    : INITIAL_CAPITAL + MONTHLY_CONTRIBUTION * totalMonths;

  console.log(`\nVINDROS MONTE CARLO SIMULATION`);
  console.log("═".repeat(70));
  console.log(`  Trades extracted: ${trades.length}`);
  console.log(`  Total months: ${totalMonths}`);
  console.log(`  Actual return: +${actualReturn.toFixed(1)}%`);
  console.log(`  Simulations: ${SIMULATIONS.toLocaleString()}`);
  console.log("");

  if (trades.length === 0) {
    console.error("No trades found in output file. Check parsing.");
    process.exit(1);
  }

  // ─── Run Simulations ────────────────────────────────────────────────────
  const returns: number[] = [];
  const drawdowns: number[] = [];

  for (let i = 0; i < SIMULATIONS; i++) {
    const shuffled = shuffle(trades);
    const result = simulateEquityCurve(shuffled, totalMonths);
    const ret = (result.finalValue / totalContributed - 1) * 100;
    returns.push(ret);
    drawdowns.push(result.maxDrawdown * 100);

    if (i % 1000 === 0)
      process.stdout.write(`\r  Simulating... ${i}/${SIMULATIONS}`);
  }
  process.stdout.write(`\r  Simulating... done!            \n`);

  // ─── Analyze Results ────────────────────────────────────────────────────
  returns.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);

  const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const meanDD = drawdowns.reduce((s, d) => s + d, 0) / drawdowns.length;
  const lossRuns = returns.filter((r) => r < 0).length;

  console.log("");
  console.log("═".repeat(70));
  console.log("RETURN DISTRIBUTION");
  console.log("═".repeat(70));
  console.log(`  Mean return:     +${meanReturn.toFixed(1)}%`);
  console.log(`  Median return:   +${percentile(returns, 50).toFixed(1)}%`);
  console.log(
    `  5th percentile:  ${percentile(returns, 5).toFixed(1)}%  (worst 5% of outcomes)`,
  );
  console.log(`  25th percentile: +${percentile(returns, 25).toFixed(1)}%`);
  console.log(`  75th percentile: +${percentile(returns, 75).toFixed(1)}%`);
  console.log(
    `  95th percentile: +${percentile(returns, 95).toFixed(1)}%  (best 5% of outcomes)`,
  );
  console.log(`  Actual result:   +${actualReturn.toFixed(1)}%`);
  console.log("");
  console.log(
    `  Prob of loss:    ${((lossRuns / SIMULATIONS) * 100).toFixed(2)}%`,
  );

  // Where does the actual result rank?
  const actualRank = returns.filter((r) => r <= actualReturn).length;
  const actualPercentile = (actualRank / SIMULATIONS) * 100;
  console.log(
    `  Actual result ranks at: ${actualPercentile.toFixed(1)}th percentile`,
  );

  console.log("");
  console.log("═".repeat(70));
  console.log("MAX DRAWDOWN DISTRIBUTION");
  console.log("═".repeat(70));
  console.log(`  Mean max DD:     ${meanDD.toFixed(1)}%`);
  console.log(`  Median max DD:   ${percentile(drawdowns, 50).toFixed(1)}%`);
  console.log(
    `  5th percentile:  ${percentile(drawdowns, 5).toFixed(1)}%  (best-case DD)`,
  );
  console.log(
    `  50th percentile: ${percentile(drawdowns, 50).toFixed(1)}%  (typical DD)`,
  );
  console.log(
    `  95th percentile: ${percentile(drawdowns, 95).toFixed(1)}%  (worst 5% DD)`,
  );
  console.log(
    `  99th percentile: ${percentile(drawdowns, 99).toFixed(1)}%  (extreme scenario)`,
  );

  console.log("");
  console.log("═".repeat(70));
  console.log("INTERPRETATION");
  console.log("═".repeat(70));
  if (actualPercentile > 50) {
    console.log(
      `  Your actual result (+${actualReturn.toFixed(1)}%) is ABOVE the median shuffled outcome.`,
    );
    console.log(
      `  This suggests trade ORDER (momentum timing) adds value — not just stock selection.`,
    );
  } else {
    console.log(`  Your actual result is BELOW the median shuffled outcome.`);
    console.log(`  This means the edge is in stock selection, not timing.`);
  }
  console.log(
    `  Probability of losing money with this trade set: ${((lossRuns / SIMULATIONS) * 100).toFixed(2)}%`,
  );
  if (lossRuns === 0) {
    console.log(
      `  → Zero simulations lost money. The edge is robust regardless of trade order.`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
