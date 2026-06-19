/**
 * Fundamental Quality Analysis — Hit Rate approach
 *
 * Question: "At any given quarter, what observable fundamental traits
 * predict +100% or more over the next 2 years?"
 *
 * For every stock at every quarter boundary (2017-Q1 to 2023-Q2):
 * 1. Compute 2-year forward return (outcome)
 * 2. Categorize the stock by fundamentals known at that date
 * 3. Report hit rates: what % of stocks in each category doubled?
 *
 * Uses reportDate to avoid look-ahead bias.
 */
import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../lib/prisma";
import * as fs from "fs";
import * as path from "path";

const OUTPUT_FILE = path.join(__dirname, "fundamental_quality_output.txt");
const FORWARD_MONTHS = 24; // 2 years
const WINNER_THRESHOLD = 100; // +100% = doubled
const MIN_PRICE = 10;

const ALL_MARKETS = [1, 2, 3, 4, 5]; // Large, Mid, Small, First North, etc.

const lines: string[] = [];
const origLog = console.log;
console.log = (...args: any[]) => {
  const line = args
    .map((a) => (typeof a === "string" ? a : String(a)))
    .join(" ");
  lines.push(line);
  origLog(...args);
};

interface Observation {
  instrumentId: number;
  name: string;
  date: string;
  forwardReturn: number;
  // Categories:
  profitable: boolean | null; // OpMargin > 0
  growing: boolean | null; // RevGrowth YoY > 15%
  revConsistency: number | null; // count of consecutive YoY growth quarters (0-4)
  sizeCategory: string | null; // "tiny" | "small" | "mid" | "large"
  operatingMargin: number | null;
  revGrowthYoY: number | null;
}

const run = async () => {
  console.log("Loading data...");

  const instruments = await prisma.instrument.findMany({
    where: { marketId: { in: ALL_MARKETS }, countryId: 1 },
    select: { id: true, name: true, marketId: true },
  });
  const instMap = new Map(instruments.map((i) => [i.id, i]));
  const instIds = instruments.map((i) => i.id);
  console.log(`  ${instruments.length} instruments`);

  // Load quarterly reports
  const reports = await prisma.quarterlyReport.findMany({
    where: { instrumentId: { in: instIds } },
    select: {
      instrumentId: true,
      year: true,
      period: true,
      revenues: true,
      operatingIncome: true,
      reportDate: true,
    },
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }, { period: "asc" }],
  });
  console.log(`  ${reports.length} quarterly reports`);

  type Report = (typeof reports)[0];
  const reportsByInst = new Map<number, Report[]>();
  for (const r of reports) {
    if (!reportsByInst.has(r.instrumentId))
      reportsByInst.set(r.instrumentId, []);
    reportsByInst.get(r.instrumentId)!.push(r);
  }

  // Load prices and build monthly map
  const allPrices = await prisma.stockPrice.findMany({
    where: { instrumentId: { in: instIds } },
    select: { instrumentId: true, date: true, close: true },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  });
  console.log(`  ${allPrices.length} price records`);

  // Build month-end prices per instrument
  const monthlyPrices = new Map<number, Map<string, number>>(); // instId -> month -> close
  let currentInst = -1;
  let currentMonth = "";
  let lastClose = 0;

  for (const p of allPrices) {
    if (p.instrumentId !== currentInst) {
      // Save last month of previous instrument
      if (currentInst > 0 && currentMonth) {
        if (!monthlyPrices.has(currentInst))
          monthlyPrices.set(currentInst, new Map());
        monthlyPrices.get(currentInst)!.set(currentMonth, lastClose);
      }
      currentInst = p.instrumentId;
      currentMonth = "";
      lastClose = 0;
    }
    const m = p.date.toISOString().slice(0, 7);
    if (m !== currentMonth && currentMonth) {
      if (!monthlyPrices.has(currentInst))
        monthlyPrices.set(currentInst, new Map());
      monthlyPrices.get(currentInst)!.set(currentMonth, lastClose);
    }
    currentMonth = m;
    lastClose = Number(p.close);
  }
  // Last instrument's last month
  if (currentInst > 0 && currentMonth) {
    if (!monthlyPrices.has(currentInst))
      monthlyPrices.set(currentInst, new Map());
    monthlyPrices.get(currentInst)!.set(currentMonth, lastClose);
  }
  console.log(`  Monthly prices for ${monthlyPrices.size} instruments`);

  // Helper: get all reports available at a given date for an instrument
  const getReportsAvailable = (instId: number, asOfDate: string): Report[] => {
    const reps = reportsByInst.get(instId);
    if (!reps) return [];
    return reps.filter(
      (r) =>
        r.reportDate && r.reportDate.toISOString().slice(0, 10) <= asOfDate,
    );
  };

  // Helper: compute revenue growth for a specific quarter vs same quarter last year
  const getRevGrowthForQuarter = (
    reps: Report[],
    year: number,
    period: number,
  ): number | null => {
    const current = reps.find((r) => r.year === year && r.period === period);
    const previous = reps.find(
      (r) => r.year === year - 1 && r.period === period,
    );
    if (!current?.revenues || !previous?.revenues) return null;
    const cur = Number(current.revenues);
    const prev = Number(previous.revenues);
    if (prev <= 0) return null;
    return (cur / prev - 1) * 100;
  };

  // Measurement dates: every quarter from 2017-Q1 to 2023-Q2 (need 2 years forward data)
  const measurementDates: string[] = [];
  for (let year = 2017; year <= 2023; year++) {
    for (const month of ["03", "06", "09", "12"]) {
      if (year === 2023 && (month === "09" || month === "12")) break; // Need 2 years forward
      const lastDay = month === "06" || month === "09" ? "30" : "31";
      measurementDates.push(`${year}-${month}-${lastDay}`);
    }
  }
  console.log(
    `\nAnalyzing ${measurementDates.length} measurement dates (2017-Q1 to 2023-Q2)...`,
  );

  const observations: Observation[] = [];

  for (const measDate of measurementDates) {
    const measMonth = measDate.slice(0, 7);
    // 24 months forward
    const fwdDate = new Date(measDate);
    fwdDate.setMonth(fwdDate.getMonth() + FORWARD_MONTHS);
    const fwdMonth = fwdDate.toISOString().slice(0, 7);

    for (const instId of instIds) {
      const prices = monthlyPrices.get(instId);
      if (!prices) continue;

      const entryPrice = prices.get(measMonth);
      if (!entryPrice || entryPrice < MIN_PRICE) continue;

      const exitPrice = prices.get(fwdMonth);
      if (!exitPrice) continue;

      const forwardReturn = (exitPrice / entryPrice - 1) * 100;

      // Get fundamentals available at measurement date
      const availableReports = getReportsAvailable(instId, measDate);
      if (availableReports.length < 2) continue; // Need some history

      // Latest report
      const latest = availableReports[availableReports.length - 1];
      const rev = latest.revenues ? Number(latest.revenues) : null;
      const opInc = latest.operatingIncome
        ? Number(latest.operatingIncome)
        : null;

      // Operating margin
      let operatingMargin: number | null = null;
      let profitable: boolean | null = null;
      if (opInc !== null && rev !== null && rev > 0) {
        operatingMargin = (opInc / rev) * 100;
        profitable = operatingMargin > 0;
      }

      // Revenue growth YoY (latest quarter vs same quarter last year)
      const revGrowthYoY = getRevGrowthForQuarter(
        availableReports,
        latest.year,
        latest.period,
      );
      const growing = revGrowthYoY !== null ? revGrowthYoY > 15 : null;

      // Revenue consistency: how many of the last 4 quarters had YoY growth > 0?
      let revConsistency: number | null = null;
      const quarters: [number, number][] = [];
      let y = latest.year;
      let p = latest.period;
      for (let i = 0; i < 4; i++) {
        quarters.push([y, p]);
        p--;
        if (p === 0) {
          p = 4;
          y--;
        }
      }
      let consecutiveGrowth = 0;
      let hasData = false;
      for (const [qy, qp] of quarters) {
        const g = getRevGrowthForQuarter(availableReports, qy, qp);
        if (g === null) break;
        hasData = true;
        if (g > 0) consecutiveGrowth++;
        else break; // Stop at first non-growth quarter
      }
      if (hasData) revConsistency = consecutiveGrowth;

      // Size category (quarterly revenue in MSEK)
      let sizeCategory: string | null = null;
      if (rev !== null) {
        const revMSEK = rev; // Already in MSEK from Börsdata
        if (revMSEK < 50) sizeCategory = "tiny";
        else if (revMSEK < 250) sizeCategory = "small";
        else if (revMSEK < 1000) sizeCategory = "mid";
        else sizeCategory = "large";
      }

      observations.push({
        instrumentId: instId,
        name: instMap.get(instId)!.name,
        date: measDate,
        forwardReturn,
        profitable,
        growing,
        revConsistency,
        sizeCategory,
        operatingMargin,
        revGrowthYoY,
      });
    }
  }

  console.log(`\nTotal observations: ${observations.length}`);

  // ─── Analysis ─────────────────────────────────────────────────────────────

  const total = observations.length;
  const winners = observations.filter(
    (o) => o.forwardReturn >= WINNER_THRESHOLD,
  );
  const baseRate = (winners.length / total) * 100;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`FUNDAMENTAL QUALITY ANALYSIS`);
  console.log(
    `Forward window: ${FORWARD_MONTHS} months | Winner threshold: +${WINNER_THRESHOLD}%`,
  );
  console.log(`${"═".repeat(70)}`);
  console.log(
    `\nBase rate: ${winners.length}/${total} = ${baseRate.toFixed(1)}% of all observations doubled in 2 years`,
  );

  // Helper: compute hit rate for a subset
  const hitRate = (subset: Observation[]) => {
    if (subset.length === 0) return { rate: 0, n: 0, avgReturn: 0 };
    const w = subset.filter((o) => o.forwardReturn >= WINNER_THRESHOLD);
    const avgReturn =
      subset.reduce((s, o) => s + o.forwardReturn, 0) / subset.length;
    return {
      rate: (w.length / subset.length) * 100,
      n: subset.length,
      avgReturn,
    };
  };

  const printRow = (
    label: string,
    data: { rate: number; n: number; avgReturn: number },
  ) => {
    console.log(
      `  ${label.padEnd(35)} ${data.rate.toFixed(1).padStart(6)}%    ${String(data.n).padStart(6)}    ${data.avgReturn.toFixed(0).padStart(7)}%`,
    );
  };

  // ── 1. Profitable? ──
  console.log(`\n  PROFITABLE (Operating Margin > 0):`);
  console.log(`  ${"─".repeat(66)}`);
  console.log(
    `  ${"Category".padEnd(35)} ${"Hit%".padStart(6)}    ${"N".padStart(6)}    ${"AvgRet".padStart(7)}`,
  );
  console.log(`  ${"─".repeat(66)}`);
  const profYes = observations.filter((o) => o.profitable === true);
  const profNo = observations.filter((o) => o.profitable === false);
  printRow("Profitable (margin > 0)", hitRate(profYes));
  printRow("Unprofitable (margin < 0)", hitRate(profNo));

  // ── 2. Growing? ──
  console.log(`\n  GROWING (Revenue YoY > 15%):`);
  console.log(`  ${"─".repeat(66)}`);
  console.log(
    `  ${"Category".padEnd(35)} ${"Hit%".padStart(6)}    ${"N".padStart(6)}    ${"AvgRet".padStart(7)}`,
  );
  console.log(`  ${"─".repeat(66)}`);
  const growYes = observations.filter((o) => o.growing === true);
  const growNo = observations.filter((o) => o.growing === false);
  printRow("Growing (rev YoY > 15%)", hitRate(growYes));
  printRow("Not growing (rev YoY <= 15%)", hitRate(growNo));

  // ── 3. Profitable AND Growing? ──
  console.log(`\n  PROFITABLE × GROWING MATRIX:`);
  console.log(`  ${"─".repeat(66)}`);
  console.log(
    `  ${"Category".padEnd(35)} ${"Hit%".padStart(6)}    ${"N".padStart(6)}    ${"AvgRet".padStart(7)}`,
  );
  console.log(`  ${"─".repeat(66)}`);
  const bothYes = observations.filter(
    (o) => o.profitable === true && o.growing === true,
  );
  const profOnlyGrow = observations.filter(
    (o) => o.profitable === true && o.growing === false,
  );
  const growOnlyProf = observations.filter(
    (o) => o.profitable === false && o.growing === true,
  );
  const neither = observations.filter(
    (o) => o.profitable === false && o.growing === false,
  );
  printRow("Profitable + Growing", hitRate(bothYes));
  printRow("Profitable only (slow growth)", hitRate(profOnlyGrow));
  printRow("Growing only (unprofitable)", hitRate(growOnlyProf));
  printRow("Neither", hitRate(neither));

  // ── 4. Revenue Consistency ──
  console.log(`\n  REVENUE CONSISTENCY (consecutive YoY growth quarters):`);
  console.log(`  ${"─".repeat(66)}`);
  console.log(
    `  ${"Category".padEnd(35)} ${"Hit%".padStart(6)}    ${"N".padStart(6)}    ${"AvgRet".padStart(7)}`,
  );
  console.log(`  ${"─".repeat(66)}`);
  for (let c = 0; c <= 4; c++) {
    const subset = observations.filter((o) => o.revConsistency === c);
    printRow(`${c} consecutive growth quarters`, hitRate(subset));
  }

  // ── 5. Size Category ──
  console.log(`\n  SIZE (quarterly revenue):`);
  console.log(`  ${"─".repeat(66)}`);
  console.log(
    `  ${"Category".padEnd(35)} ${"Hit%".padStart(6)}    ${"N".padStart(6)}    ${"AvgRet".padStart(7)}`,
  );
  console.log(`  ${"─".repeat(66)}`);
  for (const cat of ["tiny", "small", "mid", "large"]) {
    const subset = observations.filter((o) => o.sizeCategory === cat);
    const labels: Record<string, string> = {
      tiny: "Tiny (<50M rev/quarter)",
      small: "Small (50-250M)",
      mid: "Mid (250M-1B)",
      large: "Large (>1B)",
    };
    printRow(labels[cat], hitRate(subset));
  }

  // ── 6. Combined: Profitable + Growing + Consistent ──
  console.log(`\n  COMBINED QUALITY (profitable + growing + ≥3 consecutive):`);
  console.log(`  ${"─".repeat(66)}`);
  console.log(
    `  ${"Category".padEnd(35)} ${"Hit%".padStart(6)}    ${"N".padStart(6)}    ${"AvgRet".padStart(7)}`,
  );
  console.log(`  ${"─".repeat(66)}`);
  const highQuality = observations.filter(
    (o) =>
      o.profitable === true &&
      o.growing === true &&
      o.revConsistency !== null &&
      o.revConsistency >= 3,
  );
  const medQuality = observations.filter(
    (o) =>
      o.profitable === true &&
      (o.growing === true ||
        (o.revConsistency !== null && o.revConsistency >= 2)),
  );
  const lowQuality = observations.filter(
    (o) =>
      o.profitable === false && (o.growing === false || o.growing === null),
  );
  printRow("High (prof + grow + consistent)", hitRate(highQuality));
  printRow("Medium (prof + some growth)", hitRate(medQuality));
  printRow("Low (unprof + no growth)", hitRate(lowQuality));

  // ── 7. Top compounders: stocks that appeared as winners most often ──
  console.log(
    `\n  TOP COMPOUNDERS (stocks appearing as +100% winners most often):`,
  );
  console.log(`  ${"─".repeat(66)}`);
  const winnerCounts = new Map<
    number,
    { name: string; count: number; totalReturn: number }
  >();
  for (const w of winners) {
    const existing = winnerCounts.get(w.instrumentId) || {
      name: w.name,
      count: 0,
      totalReturn: 0,
    };
    existing.count++;
    existing.totalReturn += w.forwardReturn;
    winnerCounts.set(w.instrumentId, existing);
  }
  const topCompounders = [...winnerCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
  console.log(
    `  ${"Name".padEnd(25)} ${"Windows".padStart(7)}  ${"AvgFwdRet".padStart(10)}`,
  );
  console.log(`  ${"─".repeat(50)}`);
  for (const c of topCompounders) {
    const avgRet = c.totalReturn / c.count;
    console.log(
      `  ${c.name.padEnd(25)} ${String(c.count).padStart(7)}  ${(avgRet.toFixed(0) + "%").padStart(10)}`,
    );
  }

  // ── 8. What did the top compounders look like fundamentally? ──
  console.log(
    `\n  FUNDAMENTALS OF TOP 10 COMPOUNDERS (at first winner observation):`,
  );
  console.log(`  ${"─".repeat(66)}`);
  const top10Names = topCompounders.slice(0, 10).map((c) => c.name);
  for (const name of top10Names) {
    const obs = observations
      .filter((o) => o.name === name)
      .sort((a, b) => a.date.localeCompare(b.date));
    const firstWinner = obs.find((o) => o.forwardReturn >= WINNER_THRESHOLD);
    if (firstWinner) {
      const prof = firstWinner.profitable ? "✓" : "✗";
      const grow = firstWinner.growing ? "✓" : "✗";
      const cons = firstWinner.revConsistency ?? "-";
      const margin =
        firstWinner.operatingMargin !== null
          ? firstWinner.operatingMargin.toFixed(0) + "%"
          : "-";
      const revGr =
        firstWinner.revGrowthYoY !== null
          ? firstWinner.revGrowthYoY.toFixed(0) + "%"
          : "-";
      console.log(
        `  ${name.padEnd(22)} ${firstWinner.date}  Prof:${prof} Grow:${grow} Cons:${cons} Margin:${margin.padStart(5)} RevGr:${revGr.padStart(6)}`,
      );
    }
  }

  // Write output
  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  console.log(`\nOutput: ${OUTPUT_FILE}`);
  await prisma.$disconnect();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
