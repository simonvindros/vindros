/**
 * Spike Analysis
 *
 * Find every stock that had a >200% revenue growth year.
 * Then check: what happened to the stock price in the 2 years after?
 * Split by pre-spike pattern to see if context predicts outcomes.
 */
import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../lib/prisma";
import * as fs from "fs";
import * as path from "path";

const OUTPUT_FILE = path.join(__dirname, "spike_analysis_output.txt");
const SPIKE_THRESHOLD = 200; // >200% revenue growth in 1 year

const lines: string[] = [];
const origLog = console.log;
console.log = (...args: any[]) => {
  const line = args
    .map((a) => (typeof a === "string" ? a : String(a)))
    .join(" ");
  lines.push(line);
  origLog(...args);
};

const run = async () => {
  console.log("Loading data...");

  const instruments = await prisma.instrument.findMany({
    where: { marketId: { in: [1, 2, 3, 4, 5] }, countryId: 1 },
    select: { id: true, name: true, marketId: true },
  });
  const instMap = new Map(instruments.map((i) => [i.id, i]));
  const instIds = instruments.map((i) => i.id);

  // Load annual KPI: revenue growth (94)
  const kpiValues = await prisma.kpiValue.findMany({
    where: { instrumentId: { in: instIds }, kpiId: 94, reportType: "year" },
    select: { instrumentId: true, year: true, value: true },
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }],
  });
  console.log(`  ${kpiValues.length} annual revenue growth KPI values`);

  // Group by instrument
  const growthByInst = new Map<number, { year: number; value: number }[]>();
  for (const kv of kpiValues) {
    if (!growthByInst.has(kv.instrumentId))
      growthByInst.set(kv.instrumentId, []);
    growthByInst
      .get(kv.instrumentId)!
      .push({ year: kv.year, value: Number(kv.value) });
  }

  // Load monthly prices
  const allPrices = await prisma.stockPrice.findMany({
    where: { instrumentId: { in: instIds } },
    select: { instrumentId: true, date: true, close: true },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  });
  console.log(`  ${allPrices.length} price records`);

  // Build month-end prices: instId -> Map<"YYYY-MM", close>
  const monthlyPrices = new Map<number, Map<string, number>>();
  for (const p of allPrices) {
    const instId = p.instrumentId;
    const m = p.date.toISOString().slice(0, 7);
    if (!monthlyPrices.has(instId)) monthlyPrices.set(instId, new Map());
    monthlyPrices.get(instId)!.set(m, Number(p.close));
  }

  // Find all spike events
  interface SpikeEvent {
    instrumentId: number;
    name: string;
    spikeYear: number;
    spikeGrowth: number;
    preSpikePattern: string; // "accelerating" | "steady" | "recovering" | "cold_start"
    preYears: number[]; // growth rates in 2 years before spike
    postReturn2Y: number | null; // stock price return 2 years after spike year end
    postGrowthYears: number[]; // revenue growth in 2 years after spike
    sustained: boolean; // grew >0% in both years after spike
  }

  const spikeEvents: SpikeEvent[] = [];

  for (const [instId, years] of growthByInst) {
    const inst = instMap.get(instId);
    if (!inst) continue;

    for (let i = 0; i < years.length; i++) {
      if (years[i].value <= SPIKE_THRESHOLD) continue;

      const spikeYear = years[i].year;
      const spikeGrowth = years[i].value;

      // Pre-spike: 2 years before
      const preYears: number[] = [];
      for (let j = i - 2; j < i; j++) {
        if (j >= 0) preYears.push(years[j].value);
      }

      // Post-spike: revenue growth in years after
      const postGrowthYears: number[] = [];
      for (let j = i + 1; j <= i + 2; j++) {
        if (j < years.length) postGrowthYears.push(years[j].value);
      }

      // Classify pre-spike pattern
      let preSpikePattern: string;
      if (preYears.length < 2) {
        preSpikePattern = "cold_start"; // not enough history
      } else if (preYears.every((v) => v > 10)) {
        preSpikePattern = "accelerating"; // already growing well before spike
      } else if (preYears.every((v) => v >= 0)) {
        preSpikePattern = "steady"; // positive but modest before spike
      } else {
        preSpikePattern = "recovering"; // had negative years before spike
      }

      // Stock price return: from end of spike year to 2 years later
      const prices = monthlyPrices.get(instId);
      let postReturn2Y: number | null = null;
      if (prices) {
        const entryMonth = `${spikeYear}-12`; // end of spike year
        const exitMonth = `${spikeYear + 2}-12`; // 2 years later
        const entry = prices.get(entryMonth);
        const exit = prices.get(exitMonth);
        if (entry && exit && entry > 0) {
          postReturn2Y = (exit / entry - 1) * 100;
        }
      }

      const sustained =
        postGrowthYears.length >= 2 && postGrowthYears.every((v) => v > 0);

      spikeEvents.push({
        instrumentId: instId,
        name: inst.name,
        spikeYear,
        spikeGrowth,
        preSpikePattern,
        preYears,
        postReturn2Y,
        postGrowthYears,
        sustained,
      });
    }
  }

  console.log(
    `\nFound ${spikeEvents.length} spike events (>200% revenue growth in 1 year)`,
  );

  // ─── Analysis ─────────────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(70)}`);
  console.log(`SPIKE ANALYSIS: What happens after >200% revenue growth?`);
  console.log(`${"═".repeat(70)}`);

  // Split by whether growth continued
  const withPostReturn = spikeEvents.filter((e) => e.postReturn2Y !== null);
  const withPostGrowth = spikeEvents.filter(
    (e) => e.postGrowthYears.length >= 2,
  );

  console.log(
    `\n  Events with 2-year post-spike price data: ${withPostReturn.length}`,
  );
  console.log(
    `  Events with 2 years of post-spike revenue data: ${withPostGrowth.length}`,
  );

  // ── 1. Sustained vs Fluke: stock returns ──
  console.log(
    `\n  SUSTAINED vs FLUKE (did revenue keep growing >0% for 2 years after spike?):`,
  );
  console.log(`  ${"─".repeat(66)}`);
  const sustainedEvents = withPostReturn.filter((e) => e.sustained);
  const flukeEvents = withPostReturn.filter(
    (e) => !e.sustained && e.postGrowthYears.length >= 2,
  );
  const unknownEvents = withPostReturn.filter(
    (e) => e.postGrowthYears.length < 2,
  );

  const stats = (events: SpikeEvent[]) => {
    const returns = events.map((e) => e.postReturn2Y!).sort((a, b) => a - b);
    if (returns.length === 0)
      return { median: 0, avg: 0, pctPositive: 0, n: 0 };
    const median = returns[Math.floor(returns.length / 2)];
    const avg = returns.reduce((s, v) => s + v, 0) / returns.length;
    const pctPositive =
      (returns.filter((v) => v > 0).length / returns.length) * 100;
    return { median, avg, pctPositive, n: returns.length };
  };

  const printStats = (label: string, s: ReturnType<typeof stats>) => {
    console.log(
      `  ${label.padEnd(35)} Med:${s.median.toFixed(0).padStart(5)}%  Avg:${s.avg.toFixed(0).padStart(5)}%  +ve:${s.pctPositive.toFixed(0).padStart(3)}%  N:${String(s.n).padStart(4)}`,
    );
  };

  printStats("Sustained (grew >0% both years)", stats(sustainedEvents));
  printStats("Fluke (stalled/declined)", stats(flukeEvents));
  printStats("Unknown (not enough post data)", stats(unknownEvents));

  // ── 2. By pre-spike pattern ──
  console.log(`\n  BY PRE-SPIKE PATTERN (what happened before the spike):`);
  console.log(`  ${"─".repeat(66)}`);
  for (const pattern of [
    "accelerating",
    "steady",
    "recovering",
    "cold_start",
  ]) {
    const subset = withPostReturn.filter((e) => e.preSpikePattern === pattern);
    printStats(pattern, stats(subset));
  }

  // ── 3. Combined: pre-spike pattern × sustained ──
  console.log(`\n  BEST COMBO: accelerating pre-spike + sustained post-spike:`);
  console.log(`  ${"─".repeat(66)}`);
  const bestCombo = withPostReturn.filter(
    (e) => e.preSpikePattern === "accelerating" && e.sustained,
  );
  const worstCombo = withPostReturn.filter(
    (e) =>
      e.preSpikePattern === "recovering" &&
      !e.sustained &&
      e.postGrowthYears.length >= 2,
  );
  printStats("Accelerating + Sustained", stats(bestCombo));
  printStats("Recovering + Fluke", stats(worstCombo));

  // ── 4. List the sustained spikes ──
  console.log(
    `\n  SUSTAINED SPIKE STOCKS (grew >0% for 2 years after >200% spike):`,
  );
  console.log(`  ${"─".repeat(66)}`);
  console.log(
    `  ${"Name".padEnd(25)} ${"Year".padStart(5)}  ${"Spike".padStart(6)}  ${"Pre".padStart(15)}  ${"Post growth".padStart(15)}  ${"2Y Ret".padStart(7)}`,
  );
  console.log(`  ${"─".repeat(66)}`);
  const sustainedSorted = [...sustainedEvents].sort(
    (a, b) => (b.postReturn2Y ?? 0) - (a.postReturn2Y ?? 0),
  );
  for (const e of sustainedSorted.slice(0, 30)) {
    const pre = e.preYears.map((v) => v.toFixed(0) + "%").join(", ") || "-";
    const post = e.postGrowthYears.map((v) => v.toFixed(0) + "%").join(", ");
    const ret = e.postReturn2Y !== null ? e.postReturn2Y.toFixed(0) + "%" : "-";
    console.log(
      `  ${e.name.padEnd(25)} ${String(e.spikeYear).padStart(5)}  ${(e.spikeGrowth.toFixed(0) + "%").padStart(6)}  ${pre.padStart(15)}  ${post.padStart(15)}  ${ret.padStart(7)}`,
    );
  }

  // ── 5. Fluke spikes (for contrast) ──
  console.log(`\n  FLUKE SPIKE STOCKS (declined/stalled after >200% spike):`);
  console.log(`  ${"─".repeat(66)}`);
  console.log(
    `  ${"Name".padEnd(25)} ${"Year".padStart(5)}  ${"Spike".padStart(6)}  ${"Pre".padStart(15)}  ${"Post growth".padStart(15)}  ${"2Y Ret".padStart(7)}`,
  );
  console.log(`  ${"─".repeat(66)}`);
  const flukeSorted = [...flukeEvents].sort(
    (a, b) => (a.postReturn2Y ?? 0) - (b.postReturn2Y ?? 0),
  );
  for (const e of flukeSorted.slice(0, 30)) {
    const pre = e.preYears.map((v) => v.toFixed(0) + "%").join(", ") || "-";
    const post = e.postGrowthYears.map((v) => v.toFixed(0) + "%").join(", ");
    const ret = e.postReturn2Y !== null ? e.postReturn2Y.toFixed(0) + "%" : "-";
    console.log(
      `  ${e.name.padEnd(25)} ${String(e.spikeYear).padStart(5)}  ${(e.spikeGrowth.toFixed(0) + "%").padStart(6)}  ${pre.padStart(15)}  ${post.padStart(15)}  ${ret.padStart(7)}`,
    );
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  console.log(`\nOutput: ${OUTPUT_FILE}`);
  await prisma.$disconnect();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
