/**
 * MONTE CARLO RANDOM PORTFOLIOS — Null Hypothesis Test
 *
 * Question: "If I just picked 3 random stocks each month from the same universe,
 *            how often would I beat the index? How often would I match Vindros?"
 *
 * This tests whether CONCENTRATION ITSELF (3 stocks in a bull market) is the
 * alpha source, rather than the momentum signal.
 *
 * Method: 1,000 trials. Each trial picks 3 random qualified stocks each month,
 *         equal-weight, same DCA schedule. Compare distribution to actual and index.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadEngineData,
  getPriceOnDate,
  getQualifiedSmallCaps,
  latestAvailableQuarter,
  disconnect,
  INITIAL_CAPITAL,
  MONTHLY_CONTRIBUTION,
  BENCHMARK_ID,
  MIN_PRICE,
  EngineData,
} from "./engine";

const OUTPUT_FILE = path.join(__dirname, "montecarlo_random_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

const SIMULATIONS = 1_000;

// Seeded PRNG
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const run = async () => {
  log("Loading data...");
  const data = await loadEngineData();
  log(
    `Loaded ${data.tradingDates.length} trading days, ${data.allIds.length} instruments`,
  );

  // ─── Pre-compute eligible universe per month-end ───────────────────────
  // For each month-end, determine which stocks are "eligible" (have price data,
  // price >= 10 SEK, and if small-cap pass the quality gate).
  // We DON'T require momentum signal — that's the whole point of this test.
  log("Pre-computing eligible universe per month...");

  type MonthData = {
    date: string;
    eligibleIds: number[]; // instrumentIds with valid prices
    nextMonthDate: string | null;
  };

  const monthData: MonthData[] = [];
  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyYear = 0;

  for (let mi = 0; mi < data.monthEnds.length; mi++) {
    const day = data.monthEnds[mi];
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

    // Build eligible set: large/mid (just need valid price) + qualified small caps
    const eligible: number[] = [];
    const smallQualifiedSet = qualifiedSmallCaps;

    for (const instId of data.largeMidIdSet) {
      const price = getPriceOnDate(data.pricesByInstrument, instId, day);
      if (price && price >= MIN_PRICE) eligible.push(instId);
    }
    for (const instId of smallQualifiedSet) {
      const price = getPriceOnDate(data.pricesByInstrument, instId, day);
      if (price && price >= MIN_PRICE) eligible.push(instId);
    }

    const nextDate =
      mi < data.monthEnds.length - 1 ? data.monthEnds[mi + 1] : null;
    monthData.push({
      date: day,
      eligibleIds: eligible,
      nextMonthDate: nextDate,
    });
  }

  log(
    `Month-ends: ${monthData.length}, avg eligible universe: ${Math.round(monthData.reduce((s, m) => s + m.eligibleIds.length, 0) / monthData.length)} stocks`,
  );

  // ─── Compute benchmark final value ────────────────────────────────────
  let bmShares =
    INITIAL_CAPITAL /
    (getPriceOnDate(
      data.pricesByInstrument,
      BENCHMARK_ID,
      data.tradingDates[0],
    ) || 1);
  let bmContrib = INITIAL_CAPITAL;
  for (const day of data.tradingDates) {
    if (data.salaryDates.has(day)) {
      const bmPrice = getPriceOnDate(
        data.pricesByInstrument,
        BENCHMARK_ID,
        day,
      );
      if (bmPrice) bmShares += MONTHLY_CONTRIBUTION / bmPrice;
      bmContrib += MONTHLY_CONTRIBUTION;
    }
  }
  const lastDate = data.tradingDates[data.tradingDates.length - 1];
  const bmFinal =
    bmShares *
    (getPriceOnDate(data.pricesByInstrument, BENCHMARK_ID, lastDate) || 0);
  const totalContributed = bmContrib;

  // ─── Run the actual strategy to get comparison value ───────────────────
  // (We need the actual final PV for comparison. Use the value from vindros_dynamic.)
  // For speed, we'll compute the strategy return from monthly returns of eligible stocks.
  // Actually, let's just report vs known values.
  const ACTUAL_FINAL_PV = 52_576_114; // from strategy doc

  // ─── Run random portfolio simulations ──────────────────────────────────
  log(`\nRunning ${SIMULATIONS} random portfolio simulations...`);

  const rng = mulberry32(42);
  const terminalValues: number[] = [];

  for (let sim = 0; sim < SIMULATIONS; sim++) {
    if (sim % 100 === 0) process.stdout.write(`  Sim ${sim}/${SIMULATIONS}\r`);

    let cash = INITIAL_CAPITAL;
    let positions: { instId: number; shares: number; entryPrice: number }[] =
      [];
    let localContrib = INITIAL_CAPITAL;

    for (let mi = 0; mi < monthData.length; mi++) {
      const md = monthData[mi];

      // Add monthly contribution (simplified: add at month-end)
      if (mi > 0) {
        cash += MONTHLY_CONTRIBUTION;
        localContrib += MONTHLY_CONTRIBUTION;
      }

      // Compute current PV
      let currentPV = cash;
      for (const pos of positions) {
        const price = getPriceOnDate(
          data.pricesByInstrument,
          pos.instId,
          md.date,
        );
        currentPV += pos.shares * (price || pos.entryPrice);
      }

      // Sell everything
      for (const pos of positions) {
        const price = getPriceOnDate(
          data.pricesByInstrument,
          pos.instId,
          md.date,
        );
        if (price) cash += pos.shares * price;
      }
      positions = [];

      // Pick 3 random stocks from eligible universe
      const eligible = md.eligibleIds;
      if (eligible.length < 3) continue;

      const picked = new Set<number>();
      while (picked.size < 3) {
        const idx = Math.floor(rng() * eligible.length);
        picked.add(eligible[idx]);
      }

      // Equal weight into 3 stocks
      const perStock = cash / 3;
      for (const instId of picked) {
        const price = getPriceOnDate(data.pricesByInstrument, instId, md.date);
        if (!price || price < 1) continue;
        const shares = Math.floor(perStock / price);
        if (shares > 0) {
          positions.push({ instId, shares, entryPrice: price });
          cash -= shares * price;
        }
      }
    }

    // Final valuation
    let finalPV = cash;
    for (const pos of positions) {
      const price = getPriceOnDate(
        data.pricesByInstrument,
        pos.instId,
        lastDate,
      );
      finalPV += pos.shares * (price || pos.entryPrice);
    }
    terminalValues.push(finalPV);
  }

  process.stdout.write("\n");
  terminalValues.sort((a, b) => a - b);

  // ─── Output ────────────────────────────────────────────────────────────
  const median = percentile(terminalValues, 50);
  const p5 = percentile(terminalValues, 5);
  const p10 = percentile(terminalValues, 10);
  const p25 = percentile(terminalValues, 25);
  const p75 = percentile(terminalValues, 75);
  const p90 = percentile(terminalValues, 90);
  const p95 = percentile(terminalValues, 95);
  const p99 = percentile(terminalValues, 99);
  const mean =
    terminalValues.reduce((s, v) => s + v, 0) / terminalValues.length;
  const beatIndex = terminalValues.filter((v) => v >= bmFinal).length;
  const beatActual = terminalValues.filter((v) => v >= ACTUAL_FINAL_PV).length;
  const lostMoney = terminalValues.filter((v) => v < totalContributed).length;

  log("");
  log("═".repeat(80));
  log("NULL HYPOTHESIS: RANDOM 3-STOCK PORTFOLIOS");
  log("═".repeat(80));
  log("");
  log("Setup: Each month, pick 3 random stocks from the qualified universe");
  log(
    "       (same eligibility rules, same DCA, just random instead of momentum-ranked).",
  );
  log(`       ${SIMULATIONS} independent trials.`);
  log("");
  log("─".repeat(80));
  log("DISTRIBUTION OF TERMINAL VALUES:");
  log("─".repeat(80));
  log(
    `  Worst:                  ${Math.round(terminalValues[0]).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  5th percentile:         ${Math.round(p5).toLocaleString("sv-SE")} SEK (${((p5 / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  10th percentile:        ${Math.round(p10).toLocaleString("sv-SE")} SEK (${((p10 / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  25th percentile:        ${Math.round(p25).toLocaleString("sv-SE")} SEK (${((p25 / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  Median:                 ${Math.round(median).toLocaleString("sv-SE")} SEK (${((median / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  Mean:                   ${Math.round(mean).toLocaleString("sv-SE")} SEK (${((mean / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  75th percentile:        ${Math.round(p75).toLocaleString("sv-SE")} SEK (${((p75 / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  90th percentile:        ${Math.round(p90).toLocaleString("sv-SE")} SEK (${((p90 / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  95th percentile:        ${Math.round(p95).toLocaleString("sv-SE")} SEK (${((p95 / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  99th percentile:        ${Math.round(p99).toLocaleString("sv-SE")} SEK (${((p99 / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  Best:                   ${Math.round(terminalValues[terminalValues.length - 1]).toLocaleString("sv-SE")} SEK`,
  );
  log("");
  log("─".repeat(80));
  log("COMPARISONS:");
  log("─".repeat(80));
  log(
    `  Benchmark (OMXSPI DCA): ${Math.round(bmFinal).toLocaleString("sv-SE")} SEK (${((bmFinal / totalContributed - 1) * 100).toFixed(0)}%)`,
  );
  log(
    `  Vindros Dynamic actual: ${ACTUAL_FINAL_PV.toLocaleString("sv-SE")} SEK (+4,227%)`,
  );
  log("");
  log(
    `  Random portfolios beating INDEX: ${beatIndex}/${SIMULATIONS} (${((beatIndex / SIMULATIONS) * 100).toFixed(1)}%)`,
  );
  log(
    `  Random portfolios beating VINDROS: ${beatActual}/${SIMULATIONS} (${((beatActual / SIMULATIONS) * 100).toFixed(2)}%)`,
  );
  log(
    `  Random portfolios LOSING money: ${lostMoney}/${SIMULATIONS} (${((lostMoney / SIMULATIONS) * 100).toFixed(1)}%)`,
  );
  log("");
  log("─".repeat(80));
  log("INTERPRETATION:");
  log("─".repeat(80));

  const pctBeatIndex = (beatIndex / SIMULATIONS) * 100;
  if (pctBeatIndex > 60) {
    log("  → MAJORITY of random 3-stock portfolios beat the index.");
    log("    This means CONCENTRATION ALONE provides edge in this universe.");
    log(
      "    However, the momentum signal still needs to be tested against the",
    );
    log("    random median — does Vindros beat a typical random portfolio?");
  } else if (pctBeatIndex > 40) {
    log(
      "  → ~Half of random portfolios beat the index. Concentration provides",
    );
    log("    some natural edge, but it's not dominant.");
  } else {
    log("  → Most random portfolios DON'T beat the index.");
    log("    Concentration alone is NOT the edge — signal matters.");
  }

  log("");
  if (beatActual === 0) {
    log("  → ZERO random portfolios matched Vindros Dynamic.");
    log(
      "    The momentum signal is providing massive edge over random selection.",
    );
    log("    Even if concentration helps, the ranking IS the alpha.");
  } else if (beatActual < SIMULATIONS * 0.01) {
    log(
      `  → Only ${beatActual}/${SIMULATIONS} random portfolios matched Vindros.`,
    );
    log(
      "    The momentum signal is adding substantial value beyond concentration.",
    );
  } else {
    log(
      `  → ${beatActual}/${SIMULATIONS} random portfolios matched or beat Vindros.`,
    );
    log(
      "    The signal's edge over random is moderate — proceed with caution.",
    );
  }

  // ─── Histogram (text-based) ────────────────────────────────────────────
  log("");
  log("─".repeat(80));
  log("DISTRIBUTION HISTOGRAM (terminal values, SEK):");
  log("─".repeat(80));

  const bucketCount = 20;
  const minVal = terminalValues[0];
  const maxVal = Math.min(
    terminalValues[terminalValues.length - 1],
    ACTUAL_FINAL_PV * 1.5,
  );
  const bucketSize = (maxVal - minVal) / bucketCount;
  const buckets: number[] = new Array(bucketCount).fill(0);

  for (const v of terminalValues) {
    const idx = Math.min(
      Math.floor((v - minVal) / bucketSize),
      bucketCount - 1,
    );
    buckets[idx]++;
  }

  const maxBucket = Math.max(...buckets);
  const barWidth = 40;

  for (let i = 0; i < bucketCount; i++) {
    const lo = minVal + i * bucketSize;
    const bar = "█".repeat(Math.round((buckets[i] / maxBucket) * barWidth));
    const label = `${(lo / 1e6).toFixed(1)}M`.padStart(7);
    const count = String(buckets[i]).padStart(4);
    log(`  ${label} |${bar} ${count}`);
  }

  // Mark where actual and benchmark fall
  const actualBucket = Math.min(
    Math.floor((ACTUAL_FINAL_PV - minVal) / bucketSize),
    bucketCount - 1,
  );
  const bmBucket = Math.min(
    Math.floor((bmFinal - minVal) / bucketSize),
    bucketCount - 1,
  );
  log("");
  log(`  ▲ Benchmark at bucket ~${bmBucket + 1}/${bucketCount}`);
  log(
    `  ★ Vindros Dynamic at bucket ~${actualBucket + 1}/${bucketCount} (or above histogram)`,
  );

  log("");
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  log(`\nOutput: ${OUTPUT_FILE}`);
  await disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
