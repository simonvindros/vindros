/**
 * TURNOVER ANALYSIS — How often do names change?
 *
 * Tracks monthly portfolio composition changes for the Dynamic (3-slot) strategy.
 * Reports: average turnover rate, holding periods, name frequency distribution.
 * If turnover is very low → you could've just held 3 stocks and ignored the signal.
 * If very high → transaction costs matter.
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadEngineData,
  getPriceOnDate,
  getAllCandidates,
  allocatePositions,
  getQualifiedSmallCaps,
  latestAvailableQuarter,
  disconnect,
  EngineData,
} from "./engine";

const OUTPUT_FILE = path.join(__dirname, "turnover_analysis_output.txt");
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

  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyKey = 0;

  // Track holdings per month
  const monthlyHoldings: Set<number>[] = [];
  const holdingNames: Map<number, string[]> = new Map(); // instId → array of month indices held
  const nameAppearances: Map<number, number> = new Map(); // instId → count of months held
  let totalNewEntries = 0;
  let totalExits = 0;

  for (let mi = 0; mi < data.monthEnds.length; mi++) {
    const day = data.monthEnds[mi];
    const currentYear = parseInt(day.slice(0, 4));
    const currentMonth = parseInt(day.slice(5, 7));
    const currentQ = Math.ceil(currentMonth / 3);
    const qualifyKey = currentYear * 10 + currentQ;

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

    const allCandidates = getAllCandidates(data, day, qualifiedSmallCaps);
    // Use allocatePositions to get the actual 3 (or more) slots
    const { allocations } = allocatePositions(
      data,
      allCandidates,
      1_000_000,
      day,
    );
    const currentSet = new Set(allocations.map((a) => a.instrumentId));
    monthlyHoldings.push(currentSet);

    // Track appearances
    for (const instId of currentSet) {
      nameAppearances.set(instId, (nameAppearances.get(instId) || 0) + 1);
    }

    // Count new entries / exits vs previous month
    if (mi > 0) {
      const prevSet = monthlyHoldings[mi - 1];
      let newEntries = 0;
      let exits = 0;
      for (const id of currentSet) {
        if (!prevSet.has(id)) newEntries++;
      }
      for (const id of prevSet) {
        if (!currentSet.has(id)) exits++;
      }
      totalNewEntries += newEntries;
      totalExits += exits;
    }
  }

  const totalMonths = data.monthEnds.length;
  const avgPositions =
    monthlyHoldings.reduce((s, h) => s + h.size, 0) / totalMonths;
  const avgNewPerMonth = totalNewEntries / (totalMonths - 1);
  const avgExitsPerMonth = totalExits / (totalMonths - 1);
  const avgTurnoverRate = avgNewPerMonth / avgPositions; // fraction of portfolio replaced each month

  // Holding period analysis
  const holdingPeriods = [...nameAppearances.values()].sort((a, b) => a - b);
  const uniqueNames = nameAppearances.size;

  // Consecutive holding streaks
  const streaks: number[] = [];
  const instIds = [...nameAppearances.keys()];
  for (const instId of instIds) {
    let currentStreak = 0;
    for (let mi = 0; mi < monthlyHoldings.length; mi++) {
      if (monthlyHoldings[mi].has(instId)) {
        currentStreak++;
      } else {
        if (currentStreak > 0) streaks.push(currentStreak);
        currentStreak = 0;
      }
    }
    if (currentStreak > 0) streaks.push(currentStreak);
  }
  streaks.sort((a, b) => a - b);

  // Top holdings by frequency
  const sorted = [...nameAppearances.entries()].sort((a, b) => b[1] - a[1]);

  log("═".repeat(90));
  log("TURNOVER ANALYSIS — PORTFOLIO CHURN");
  log("═".repeat(90));
  log(
    `Period: ${data.monthEnds[0]} to ${data.monthEnds[totalMonths - 1]} (${totalMonths} months)`,
  );
  log("");

  log("─".repeat(90));
  log("SUMMARY:");
  log("─".repeat(90));
  log(`  Average positions per month:      ${avgPositions.toFixed(1)}`);
  log(`  Average new entries per month:    ${avgNewPerMonth.toFixed(2)}`);
  log(`  Average exits per month:          ${avgExitsPerMonth.toFixed(2)}`);
  log(
    `  Monthly turnover rate:            ${(avgTurnoverRate * 100).toFixed(1)}% of portfolio replaced/month`,
  );
  log(
    `  Annual turnover rate:             ${(avgTurnoverRate * 12 * 100).toFixed(0)}%`,
  );
  log(`  Unique stocks held (total):       ${uniqueNames}`);
  log("");

  log("─".repeat(90));
  log("HOLDING PERIOD DISTRIBUTION (consecutive months held):");
  log("─".repeat(90));
  const percentile = (arr: number[], p: number) => {
    const idx = Math.floor((p / 100) * (arr.length - 1));
    return arr[idx];
  };
  log(`  Min:    ${streaks[0]} months`);
  log(`  25th:   ${percentile(streaks, 25)} months`);
  log(`  Median: ${percentile(streaks, 50)} months`);
  log(`  75th:   ${percentile(streaks, 75)} months`);
  log(`  90th:   ${percentile(streaks, 90)} months`);
  log(`  Max:    ${streaks[streaks.length - 1]} months`);
  log(
    `  Mean:   ${(streaks.reduce((s, v) => s + v, 0) / streaks.length).toFixed(1)} months`,
  );
  log("");

  // Distribution buckets
  const buckets = [1, 2, 3, 6, 12, 24, 60, Infinity];
  const bucketLabels = [
    "1 mo",
    "2 mo",
    "3 mo",
    "4-6 mo",
    "7-12 mo",
    "13-24 mo",
    "25-60 mo",
    "60+ mo",
  ];
  log("  Holding period buckets:");
  let prevBucket = 0;
  for (let i = 0; i < buckets.length; i++) {
    const count = streaks.filter(
      (s) => s > prevBucket && s <= buckets[i],
    ).length;
    const pct = ((count / streaks.length) * 100).toFixed(1);
    log(`    ${bucketLabels[i].padEnd(10)}: ${count} holds (${pct}%)`);
    prevBucket = buckets[i];
  }

  log("");
  log("─".repeat(90));
  log("TOP 20 MOST FREQUENTLY HELD STOCKS:");
  log("─".repeat(90));
  log(
    `  ${"#".padEnd(4)} ${"Name".padEnd(30)} ${"Months Held".padStart(12)} ${"% of Time".padStart(10)}`,
  );
  log("  " + "─".repeat(60));
  for (let i = 0; i < Math.min(20, sorted.length); i++) {
    const [instId, count] = sorted[i];
    const name = data.nameMap.get(instId) || String(instId);
    const pct = ((count / totalMonths) * 100).toFixed(1);
    log(
      `  ${String(i + 1).padEnd(4)} ${name.padEnd(30)} ${String(count).padStart(12)} ${(pct + "%").padStart(10)}`,
    );
  }

  log("");
  log("─".repeat(90));
  log("INTERPRETATION:");
  log("─".repeat(90));
  if (avgTurnoverRate < 0.15) {
    log(
      "  LOW TURNOVER — You could approximate this strategy by holding a few stocks",
    );
    log(
      "  for extended periods. The signal is more about WHICH stocks than WHEN to trade.",
    );
  } else if (avgTurnoverRate < 0.4) {
    log(
      "  MODERATE TURNOVER — The signal actively rotates. This is NOT a buy-and-hold.",
    );
    log("  Transaction costs are manageable (1-2 trades/month).");
  } else {
    log(
      "  HIGH TURNOVER — New names every month. Transaction costs and slippage matter.",
    );
    log("  Consider: does the alpha survive after realistic costs?");
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
