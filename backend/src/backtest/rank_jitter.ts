/**
 * RANK JITTER TEST — How sensitive is the result to exact ranking?
 *
 * Instead of always picking ranks 1-2-3, randomly pick 3 from the top N
 * candidates each month. Tests whether the strategy's outcome depends on
 * coin-flip decisions at the ranking margin.
 *
 * If results cluster tightly → system is robust (the whole top tier is good)
 * If results spread wildly → system is fragile (you got lucky with exact picks)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadEngineData,
  getPriceOnDate,
  getEffectiveADV,
  getAllCandidates,
  getQualifiedSmallCaps,
  latestAvailableQuarter,
  disconnect,
  INITIAL_CAPITAL,
  MONTHLY_CONTRIBUTION,
  BENCHMARK_ID,
  MIN_POSITIONS,
  MAX_POSITIONS,
  MAX_ADV_FRACTION,
  Position,
  Allocation,
  Candidate,
  EngineData,
} from "./engine";

const OUTPUT_FILE = path.join(__dirname, "rank_jitter_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

const SIMULATIONS = 1_000;
const JITTER_POOL = 5; // Pick 3 from top 5 (instead of always top 3)

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

// Allocate positions from a subset of candidates (with jittered selection)
function allocateJittered(
  data: EngineData,
  candidates: Candidate[],
  portfolioValue: number,
  dateStr: string,
  selectedIndices: number[], // which candidate indices to use
): Allocation[] {
  const targetPerSlot = portfolioValue / MIN_POSITIONS;
  const allocations: Allocation[] = [];
  let remaining = portfolioValue;
  const usedTradeIds = new Set<number>();

  // First pass: allocate the jittered selection in order
  for (const idx of selectedIndices) {
    if (remaining <= 100) break;
    if (idx >= candidates.length) continue;
    const c = candidates[idx];

    const { adv, tradeId } = getEffectiveADV(
      data.pricesByInstrument,
      data.aToBMap,
      c.instrumentId,
      dateStr,
    );

    if (usedTradeIds.has(tradeId)) continue;
    if (usedTradeIds.has(c.instrumentId)) continue;
    const counterpartId =
      data.aToBMap.get(c.instrumentId) ?? data.bToAMap.get(c.instrumentId);
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

  // If jittered picks didn't fill all slots (ADV caps), continue with remaining candidates
  let candidateIdx = 0;
  const selectedSet = new Set(selectedIndices);
  while (
    remaining > 100 &&
    candidateIdx < candidates.length &&
    allocations.length < MAX_POSITIONS
  ) {
    if (selectedSet.has(candidateIdx)) {
      candidateIdx++;
      continue;
    }
    const c = candidates[candidateIdx];
    candidateIdx++;

    const { adv, tradeId } = getEffectiveADV(
      data.pricesByInstrument,
      data.aToBMap,
      c.instrumentId,
      dateStr,
    );

    if (usedTradeIds.has(tradeId)) continue;
    if (usedTradeIds.has(c.instrumentId)) continue;
    const counterpartId =
      data.aToBMap.get(c.instrumentId) ?? data.bToAMap.get(c.instrumentId);
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
      const { adv } = getEffectiveADV(
        data.pricesByInstrument,
        data.aToBMap,
        a.instrumentId,
        dateStr,
      );
      const maxByLiquidity = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
      return a.allocation < maxByLiquidity * 0.99;
    });
    if (uncapped.length === 0) break;
    const perStock = remaining / uncapped.length;
    let distributed = 0;
    for (const a of uncapped) {
      const { adv } = getEffectiveADV(
        data.pricesByInstrument,
        data.aToBMap,
        a.instrumentId,
        dateStr,
      );
      const maxByLiquidity = adv > 0 ? adv * MAX_ADV_FRACTION : Infinity;
      const room = maxByLiquidity - a.allocation;
      const topUp = Math.min(perStock, room);
      if (topUp > 0) {
        a.allocation += topUp;
        distributed += topUp;
      }
    }
    remaining -= distributed;
    if (distributed < 100) break;
  }

  return allocations;
}

const run = async () => {
  log("Loading data...");
  const data = await loadEngineData();
  log(
    `Loaded ${data.tradingDates.length} trading days, ${data.allIds.length} instruments`,
  );
  log("");

  // ─── Pre-compute candidates for each month-end ─────────────────────────
  // (Expensive — do once, reuse for all simulations)
  log("Pre-computing monthly candidates...");

  type MonthState = {
    date: string;
    candidates: Candidate[];
    salaryAdded: boolean; // whether a salary contribution happens this month
  };

  const monthStates: MonthState[] = [];
  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyYear = 0;

  // Track which trading days have salary deposits before each month-end
  const salaryByMonth: boolean[] = [];
  let currentMonthHasSalary = false;

  for (const day of data.tradingDates) {
    if (data.salaryDates.has(day)) currentMonthHasSalary = true;

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
      const allCandidates = getAllCandidates(data, day, qualifiedSmallCaps);
      monthStates.push({
        date: day,
        candidates: allCandidates,
        salaryAdded: currentMonthHasSalary,
      });
      currentMonthHasSalary = false;
    }
  }

  log(`Month-ends pre-computed: ${monthStates.length}`);
  log("");

  // ─── Run the DETERMINISTIC version (always top 3) for reference ────────
  const runSim = (rng: (() => number) | null): number => {
    let cash = INITIAL_CAPITAL;
    let positions: Position[] = [];
    let totalContributed = INITIAL_CAPITAL;

    for (const ms of monthStates) {
      // Add monthly contribution
      if (ms.salaryAdded) {
        cash += MONTHLY_CONTRIBUTION;
        totalContributed += MONTHLY_CONTRIBUTION;
      }

      // Current portfolio value
      let currentPV = cash;
      for (const pos of positions) {
        const p =
          getPriceOnDate(data.pricesByInstrument, pos.tradeId, ms.date) ||
          pos.entryPrice;
        currentPV += pos.shares * p;
      }

      // Select candidates — deterministic or jittered
      let allocations: Allocation[];

      if (rng === null) {
        // Deterministic: always pick indices 0, 1, 2
        allocations = allocateJittered(
          data,
          ms.candidates,
          currentPV,
          ms.date,
          [0, 1, 2],
        );
      } else {
        // Jittered: randomly pick 3 from top JITTER_POOL
        const poolSize = Math.min(JITTER_POOL, ms.candidates.length);
        const available = Array.from({ length: poolSize }, (_, i) => i);
        // Fisher-Yates partial shuffle to pick 3
        const picks: number[] = [];
        for (let i = 0; i < Math.min(3, available.length); i++) {
          const j = i + Math.floor(rng() * (available.length - i));
          [available[i], available[j]] = [available[j], available[i]];
          picks.push(available[i]);
        }
        picks.sort((a, b) => a - b); // keep in rank order for allocation priority
        allocations = allocateJittered(
          data,
          ms.candidates,
          currentPV,
          ms.date,
          picks,
        );
      }

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
            ms.date,
          );
          if (price) cash += price * pos.shares;
        }
      }
      positions = keepPositions;

      // Rebalance existing positions
      const allocationMap = new Map(
        allocations.map((a) => [a.instrumentId, a]),
      );
      for (const pos of positions) {
        const alloc = allocationMap.get(pos.instrumentId);
        if (!alloc) continue;
        const price = getPriceOnDate(
          data.pricesByInstrument,
          pos.tradeId,
          ms.date,
        );
        if (!price) continue;
        const currentValue = pos.shares * price;
        const target = alloc.allocation;
        if (currentValue > target * 1.01) {
          const sellShares = Math.floor((currentValue - target) / price);
          if (sellShares > 0) {
            cash += sellShares * price;
            pos.shares -= sellShares;
          }
        } else if (currentValue < target * 0.99) {
          const buyShares = Math.floor((target - currentValue) / price);
          if (buyShares > 0 && cash >= buyShares * price) {
            cash -= buyShares * price;
            pos.shares += buyShares;
          }
        }
      }

      // Buy new entries
      const heldSignalIds = new Set(positions.map((p) => p.instrumentId));
      for (const a of allocations) {
        if (heldSignalIds.has(a.instrumentId)) continue;
        const price = getPriceOnDate(
          data.pricesByInstrument,
          a.tradeId,
          ms.date,
        );
        if (!price) continue;
        const shares = Math.floor(Math.min(a.allocation, cash) / price);
        if (shares === 0) continue;
        positions.push({
          instrumentId: a.instrumentId,
          tradeId: a.tradeId,
          name: data.nameMap.get(a.instrumentId) || "",
          entryDate: ms.date,
          entryPrice: price,
          shares,
          pool: a.pool,
        });
        cash -= shares * price;
      }
    }

    // Final value
    const lastDate = monthStates[monthStates.length - 1].date;
    let finalPV = cash;
    for (const pos of positions) {
      const price = getPriceOnDate(
        data.pricesByInstrument,
        pos.tradeId,
        lastDate,
      );
      finalPV += pos.shares * (price || pos.entryPrice);
    }
    return finalPV;
  };

  // ─── Run deterministic baseline ───────────────────────────────────────
  log("Running deterministic baseline (always top 3)...");
  const deterministicPV = runSim(null);
  log(
    `  Deterministic result: ${Math.round(deterministicPV).toLocaleString("sv-SE")} SEK`,
  );
  log("");

  // ─── Run jittered simulations ─────────────────────────────────────────
  log(
    `Running ${SIMULATIONS} jittered simulations (pick 3 from top ${JITTER_POOL})...`,
  );
  const rng = mulberry32(42);
  const jitteredValues: number[] = [];

  for (let sim = 0; sim < SIMULATIONS; sim++) {
    if (sim % 100 === 0) process.stdout.write(`  Sim ${sim}/${SIMULATIONS}\r`);
    const simRng = mulberry32(Math.floor(rng() * 2147483647));
    const pv = runSim(simRng);
    jitteredValues.push(pv);
  }
  process.stdout.write("\n");

  jitteredValues.sort((a, b) => a - b);

  // ─── Results ───────────────────────────────────────────────────────────
  const median = percentile(jitteredValues, 50);
  const p5 = percentile(jitteredValues, 5);
  const p10 = percentile(jitteredValues, 10);
  const p25 = percentile(jitteredValues, 25);
  const p75 = percentile(jitteredValues, 75);
  const p90 = percentile(jitteredValues, 90);
  const p95 = percentile(jitteredValues, 95);
  const mean =
    jitteredValues.reduce((s, v) => s + v, 0) / jitteredValues.length;
  const worst = jitteredValues[0];
  const best = jitteredValues[jitteredValues.length - 1];
  const spread = ((best - worst) / median) * 100;
  const iqr = ((p75 - p25) / median) * 100;

  // Benchmark
  let bmShares =
    INITIAL_CAPITAL /
    (getPriceOnDate(
      data.pricesByInstrument,
      BENCHMARK_ID,
      data.tradingDates[0],
    ) || 1);
  for (const day of data.tradingDates) {
    if (data.salaryDates.has(day)) {
      const bmPrice = getPriceOnDate(
        data.pricesByInstrument,
        BENCHMARK_ID,
        day,
      );
      if (bmPrice) bmShares += MONTHLY_CONTRIBUTION / bmPrice;
    }
  }
  const lastDate = data.tradingDates[data.tradingDates.length - 1];
  const bmFinal =
    bmShares *
    (getPriceOnDate(data.pricesByInstrument, BENCHMARK_ID, lastDate) || 0);
  const totalContributed =
    INITIAL_CAPITAL +
    monthStates.filter((m) => m.salaryAdded).length * MONTHLY_CONTRIBUTION;
  const allBeat = jitteredValues.filter((v) => v >= bmFinal).length;

  log("");
  log("═".repeat(80));
  log(
    `RANK JITTER TEST — PICK 3 FROM TOP ${JITTER_POOL} (${SIMULATIONS} SIMULATIONS)`,
  );
  log("═".repeat(80));
  log("");
  log("Question: What if you didn't always pick ranks #1-#2-#3, but randomly");
  log(`          picked 3 stocks from the top ${JITTER_POOL} each month?`);
  log("");
  log("─".repeat(80));
  log("DISTRIBUTION OF TERMINAL VALUES:");
  log("─".repeat(80));
  log(
    `  Deterministic (top 3): ${Math.round(deterministicPV).toLocaleString("sv-SE")} SEK`,
  );
  log("");
  log(
    `  Worst jittered:        ${Math.round(worst).toLocaleString("sv-SE")} SEK`,
  );
  log(`  5th percentile:        ${Math.round(p5).toLocaleString("sv-SE")} SEK`);
  log(
    `  10th percentile:       ${Math.round(p10).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  25th percentile:       ${Math.round(p25).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  Median:                ${Math.round(median).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  Mean:                  ${Math.round(mean).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  75th percentile:       ${Math.round(p75).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  90th percentile:       ${Math.round(p90).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  95th percentile:       ${Math.round(p95).toLocaleString("sv-SE")} SEK`,
  );
  log(
    `  Best jittered:         ${Math.round(best).toLocaleString("sv-SE")} SEK`,
  );
  log("");
  log("─".repeat(80));
  log("SPREAD ANALYSIS:");
  log("─".repeat(80));
  log(
    `  IQR (25th–75th):       ${Math.round(p25).toLocaleString("sv-SE")} – ${Math.round(p75).toLocaleString("sv-SE")} SEK`,
  );
  log(`  IQR as % of median:    ±${(iqr / 2).toFixed(1)}%`);
  log(
    `  Full range:            ${Math.round(worst).toLocaleString("sv-SE")} – ${Math.round(best).toLocaleString("sv-SE")} SEK`,
  );
  log(`  Full spread / median:  ${spread.toFixed(0)}%`);
  log("");
  log(
    `  Jittered beating index: ${allBeat}/${SIMULATIONS} (${((allBeat / SIMULATIONS) * 100).toFixed(1)}%)`,
  );
  log(
    `  Benchmark:              ${Math.round(bmFinal).toLocaleString("sv-SE")} SEK`,
  );
  log("");
  log("─".repeat(80));
  log("INTERPRETATION:");
  log("─".repeat(80));

  if (iqr < 40) {
    log(
      `  → IQR spread is ${(iqr / 2).toFixed(0)}% around the median. This is TIGHT.`,
    );
    log("    The strategy is ROBUST to exact rank selection.");
    log("    Whether you pick #1-#2-#3 or #2-#3-#5, you get similar outcomes.");
    log("    The WHOLE top tier is good, not just the exact top 3.");
  } else if (iqr < 80) {
    log(
      `  → IQR spread is ±${(iqr / 2).toFixed(0)}% around the median. MODERATE sensitivity.`,
    );
    log("    Some months, the #4 or #5 stock diverges significantly from #3.");
    log("    The strategy works, but exact ranking matters somewhat.");
    log("    Expect real-world results within this range.");
  } else {
    log(
      `  → IQR spread is ±${(iqr / 2).toFixed(0)}% around the median. HIGH sensitivity.`,
    );
    log(
      "    The strategy is FRAGILE to exact picks. Small ranking differences",
    );
    log("    at the margin lead to wildly different outcomes.");
    log(
      "    The backtest result depends heavily on getting lucky with exact timing.",
    );
  }

  log("");
  if (allBeat === SIMULATIONS) {
    log(
      "  ALL jittered runs beat the index. Even with random rank perturbation,",
    );
    log("  the strategy dominates.");
  } else if (allBeat > SIMULATIONS * 0.95) {
    log(
      `  ${((allBeat / SIMULATIONS) * 100).toFixed(1)}% of jittered runs beat the index.`,
    );
    log(
      "  Very high confidence the strategy beats the benchmark regardless of exact picks.",
    );
  } else {
    log(
      `  ${((allBeat / SIMULATIONS) * 100).toFixed(1)}% of jittered runs beat the index.`,
    );
    log("  Some jittered paths underperform — exact selection matters.");
  }

  // Compare deterministic to jittered median
  log("");
  const detVsMedian = ((deterministicPV / median - 1) * 100).toFixed(1);
  log(`  Your deterministic result vs jittered median: ${detVsMedian}%`);
  if (Math.abs(parseFloat(detVsMedian)) < 20) {
    log("  → Your actual result is CLOSE to what jittered picking would give.");
    log("    No evidence of ranking luck.");
  } else if (parseFloat(detVsMedian) > 20) {
    log("  → Your deterministic result is ABOVE the jittered median.");
    log("    Always picking #1-#2-#3 is better than random top-5 picks.");
    log("    The slope ranking provides real value even within the top tier.");
  } else {
    log("  → Your deterministic result is BELOW the jittered median.");
    log("    Strictly picking top 3 isn't optimal — you might benefit from");
    log("    diversifying within the top 5.");
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
