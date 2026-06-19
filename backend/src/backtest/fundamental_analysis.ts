/**
 * Fundamental Factor Analysis
 *
 * For every stock at every quarter boundary, compute:
 * 1. Forward 6-month return (outcome)
 * 2. Fundamentals available at that point (from QuarterlyReport, using reportDate)
 *
 * Then analyze: which fundamental metrics predict future winners?
 */
import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../lib/prisma";
import * as fs from "fs";
import * as path from "path";

const OUTPUT_FILE = path.join(__dirname, "fundamental_analysis_output.txt");
const FORWARD_MONTHS = 6;

const lines: string[] = [];
const origLog = console.log;
console.log = (...args: any[]) => {
  const line = args
    .map((a) => (typeof a === "string" ? a : String(a)))
    .join(" ");
  lines.push(line);
  origLog(...args);
};
const LARGE_MID_MARKETS = [1, 2]; // Large Cap, Mid Cap
const SMALL_MARKETS = [3, 4, 5];
const ALL_MARKETS = [...LARGE_MID_MARKETS, ...SMALL_MARKETS];
const MIN_PRICE = 10;

interface FundamentalSnapshot {
  instrumentId: number;
  name: string;
  marketId: number;
  date: string; // measurement date
  forwardReturn: number; // % return over next N months
  // Fundamentals known at measurement date:
  revGrowthYoY: number | null; // YoY quarterly revenue growth
  operatingMargin: number | null; // operating income / revenue
  marginChangeYoY: number | null; // margin this Q vs same Q last year
  revenueAcceleration: number | null; // growth this Q vs growth prev Q
  epsGrowthYoY: number | null; // EPS growth YoY
  revenueMSEK: number | null; // absolute revenue size
}

const run = async () => {
  console.log("Loading data...");

  // Load instruments
  const instruments = await prisma.instrument.findMany({
    where: { marketId: { in: ALL_MARKETS }, countryId: 1 },
    select: { id: true, name: true, marketId: true },
  });
  const instMap = new Map(
    instruments.map((i) => [i.id, { ...i, marketId: i.marketId ?? 0 }]),
  );
  const instIds = instruments.map((i) => i.id);
  console.log(`  ${instruments.length} instruments`);

  // Load all quarterly reports
  const reports = await prisma.quarterlyReport.findMany({
    where: { instrumentId: { in: instIds } },
    select: {
      instrumentId: true,
      year: true,
      period: true,
      revenues: true,
      operatingIncome: true,
      earningsPerShare: true,
      reportDate: true,
    },
    orderBy: [{ instrumentId: "asc" }, { year: "asc" }, { period: "asc" }],
  });
  console.log(`  ${reports.length} quarterly reports`);

  // Index reports by instrument
  type Report = (typeof reports)[0];
  const reportsByInst = new Map<number, Report[]>();
  for (const r of reports) {
    if (!reportsByInst.has(r.instrumentId))
      reportsByInst.set(r.instrumentId, []);
    reportsByInst.get(r.instrumentId)!.push(r);
  }

  // Load monthly prices (last trading day per month)
  const allPrices = await prisma.stockPrice.findMany({
    where: { instrumentId: { in: instIds } },
    select: { instrumentId: true, date: true, close: true },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  });
  console.log(`  ${allPrices.length} price records`);

  // Build monthly price map: instId -> [{date, close}] (last per month)
  type PricePoint = { date: string; close: number };
  const monthlyPrices = new Map<number, PricePoint[]>();
  let currentInst = -1;
  let currentMonth = "";
  let lastPrice: { date: Date; close: any } | null = null;

  for (const p of allPrices) {
    if (p.instrumentId !== currentInst) {
      if (lastPrice && currentInst > 0) {
        const arr = monthlyPrices.get(currentInst) || [];
        arr.push({
          date: lastPrice.date.toISOString().slice(0, 10),
          close: Number(lastPrice.close),
        });
        monthlyPrices.set(currentInst, arr);
      }
      currentInst = p.instrumentId;
      currentMonth = "";
      lastPrice = null;
    }
    const m = p.date.toISOString().slice(0, 7);
    if (m !== currentMonth && lastPrice) {
      const arr = monthlyPrices.get(currentInst) || [];
      arr.push({
        date: lastPrice.date.toISOString().slice(0, 10),
        close: Number(lastPrice.close),
      });
      monthlyPrices.set(currentInst, arr);
    }
    currentMonth = m;
    lastPrice = p;
  }
  // Don't forget last instrument's last month
  if (lastPrice && currentInst > 0) {
    const arr = monthlyPrices.get(currentInst) || [];
    arr.push({
      date: lastPrice.date.toISOString().slice(0, 10),
      close: Number(lastPrice.close),
    });
    monthlyPrices.set(currentInst, arr);
  }
  console.log(`  Monthly prices built for ${monthlyPrices.size} instruments`);

  // Helper: get latest report available at a given date
  const getLatestReport = (instId: number, asOfDate: string): Report | null => {
    const reps = reportsByInst.get(instId);
    if (!reps) return null;
    let latest: Report | null = null;
    for (const r of reps) {
      if (!r.reportDate) continue;
      if (r.reportDate.toISOString().slice(0, 10) <= asOfDate) {
        latest = r;
      }
    }
    return latest;
  };

  // Helper: get report for same quarter last year
  const getSameQuarterLastYear = (
    instId: number,
    year: number,
    period: number,
  ): Report | null => {
    const reps = reportsByInst.get(instId);
    if (!reps) return null;
    return reps.find((r) => r.year === year - 1 && r.period === period) || null;
  };

  // Helper: get previous quarter's report
  const getPrevQuarter = (
    instId: number,
    year: number,
    period: number,
  ): Report | null => {
    const reps = reportsByInst.get(instId);
    if (!reps) return null;
    const prevYear = period === 1 ? year - 1 : year;
    const prevPeriod = period === 1 ? 4 : period - 1;
    return (
      reps.find((r) => r.year === prevYear && r.period === prevPeriod) || null
    );
  };

  // Measurement dates: every quarter boundary from 2017-Q2 to 2025-Q2
  const measurementDates: string[] = [];
  for (let year = 2017; year <= 2025; year++) {
    for (const month of ["03-31", "06-30", "09-30", "12-31"]) {
      measurementDates.push(`${year}-${month}`);
    }
  }

  console.log(`\nAnalyzing ${measurementDates.length} measurement dates...`);

  const snapshots: FundamentalSnapshot[] = [];

  for (const measDate of measurementDates) {
    for (const instId of instIds) {
      const prices = monthlyPrices.get(instId);
      if (!prices || prices.length < FORWARD_MONTHS + 1) continue;

      // Find price at measurement date (closest month)
      const measMonth = measDate.slice(0, 7);
      const priceIdx = prices.findIndex(
        (p) => p.date.slice(0, 7) === measMonth,
      );
      if (priceIdx < 0) continue;
      const entryPrice = prices[priceIdx].close;
      if (entryPrice < MIN_PRICE) continue;

      // Forward return
      const fwdIdx = priceIdx + FORWARD_MONTHS;
      if (fwdIdx >= prices.length) continue;
      const exitPrice = prices[fwdIdx].close;
      const forwardReturn = (exitPrice / entryPrice - 1) * 100;

      // Get fundamentals available at this date
      const latestReport = getLatestReport(instId, measDate);
      if (!latestReport || !latestReport.revenues) continue;

      const rev = Number(latestReport.revenues);
      const opInc = latestReport.operatingIncome
        ? Number(latestReport.operatingIncome)
        : null;
      const eps = latestReport.earningsPerShare
        ? Number(latestReport.earningsPerShare)
        : null;

      // YoY revenue growth
      const sameQLY = getSameQuarterLastYear(
        instId,
        latestReport.year,
        latestReport.period,
      );
      let revGrowthYoY: number | null = null;
      if (sameQLY && sameQLY.revenues && Number(sameQLY.revenues) > 0) {
        revGrowthYoY = (rev / Number(sameQLY.revenues) - 1) * 100;
      }

      // Operating margin
      let operatingMargin: number | null = null;
      if (opInc !== null && rev > 0) {
        operatingMargin = (opInc / rev) * 100;
      }

      // Margin change YoY
      let marginChangeYoY: number | null = null;
      if (
        sameQLY &&
        sameQLY.revenues &&
        sameQLY.operatingIncome &&
        Number(sameQLY.revenues) > 0
      ) {
        const prevMargin =
          (Number(sameQLY.operatingIncome) / Number(sameQLY.revenues)) * 100;
        if (operatingMargin !== null) {
          marginChangeYoY = operatingMargin - prevMargin;
        }
      }

      // Revenue acceleration (growth this Q vs growth previous Q)
      let revenueAcceleration: number | null = null;
      if (revGrowthYoY !== null) {
        const prevQ = getPrevQuarter(
          instId,
          latestReport.year,
          latestReport.period,
        );
        if (prevQ && prevQ.revenues) {
          const prevPrevYear =
            latestReport.period === 1
              ? latestReport.year - 2
              : latestReport.year - 1;
          const prevPrevPeriod =
            latestReport.period === 1 ? 4 : latestReport.period - 1;
          const prevQLY = getSameQuarterLastYear(
            instId,
            prevQ.year,
            prevQ.period,
          );
          if (prevQLY && prevQLY.revenues && Number(prevQLY.revenues) > 0) {
            const prevGrowth =
              (Number(prevQ.revenues) / Number(prevQLY.revenues) - 1) * 100;
            revenueAcceleration = revGrowthYoY - prevGrowth;
          }
        }
      }

      // EPS growth YoY
      let epsGrowthYoY: number | null = null;
      if (eps !== null && sameQLY && sameQLY.earningsPerShare) {
        const prevEps = Number(sameQLY.earningsPerShare);
        if (prevEps > 0) {
          epsGrowthYoY = (eps / prevEps - 1) * 100;
        }
      }

      const inst = instMap.get(instId)!;
      snapshots.push({
        instrumentId: instId,
        name: inst.name,
        marketId: inst.marketId ?? 0,
        date: measDate,
        forwardReturn,
        revGrowthYoY,
        operatingMargin,
        marginChangeYoY,
        revenueAcceleration,
        epsGrowthYoY,
        revenueMSEK: rev,
      });
    }
  }

  console.log(`\nTotal snapshots: ${snapshots.length}`);

  // ─── Analysis ────────────────────────────────────────────────────────────

  // Split into buckets
  const bigWinners = snapshots.filter((s) => s.forwardReturn >= 50);
  const moderate = snapshots.filter(
    (s) => s.forwardReturn >= 0 && s.forwardReturn < 50,
  );
  const losers = snapshots.filter((s) => s.forwardReturn < 0);
  const bigLosers = snapshots.filter((s) => s.forwardReturn <= -30);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`FUNDAMENTAL FACTOR ANALYSIS`);
  console.log(`Forward return window: ${FORWARD_MONTHS} months`);
  console.log(`${"═".repeat(70)}`);
  console.log(`\nBuckets:`);
  console.log(`  Big winners (>+50%):  ${bigWinners.length}`);
  console.log(`  Moderate (0-50%):     ${moderate.length}`);
  console.log(`  Losers (<0%):         ${losers.length}`);
  console.log(`  Big losers (<-30%):   ${bigLosers.length}`);

  // Analyze each metric
  const analyzeMetric = (
    name: string,
    getter: (s: FundamentalSnapshot) => number | null,
  ) => {
    const compute = (bucket: FundamentalSnapshot[]) => {
      const values = bucket.map(getter).filter((v): v is number => v !== null);
      if (values.length === 0)
        return { median: NaN, avg: NaN, pctPositive: NaN, n: 0 };
      values.sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)];
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const pctPositive =
        (values.filter((v) => v > 0).length / values.length) * 100;
      return { median, avg, pctPositive, n: values.length };
    };

    const bw = compute(bigWinners);
    const mod = compute(moderate);
    const los = compute(losers);
    const bl = compute(bigLosers);

    console.log(`\n  ${name}:`);
    console.log(`  ${"─".repeat(66)}`);
    console.log(
      `  ${"Bucket".padEnd(20)} ${"Median".padStart(8)} ${"Avg".padStart(8)} ${"% Positive".padStart(12)} ${"N".padStart(6)}`,
    );
    console.log(`  ${"─".repeat(66)}`);
    console.log(
      `  ${"Big winners >+50%".padEnd(20)} ${bw.median.toFixed(1).padStart(8)} ${bw.avg.toFixed(1).padStart(8)} ${bw.pctPositive.toFixed(0).padStart(11)}% ${bw.n.toString().padStart(6)}`,
    );
    console.log(
      `  ${"Moderate 0-50%".padEnd(20)} ${mod.median.toFixed(1).padStart(8)} ${mod.avg.toFixed(1).padStart(8)} ${mod.pctPositive.toFixed(0).padStart(11)}% ${mod.n.toString().padStart(6)}`,
    );
    console.log(
      `  ${"Losers <0%".padEnd(20)} ${los.median.toFixed(1).padStart(8)} ${los.avg.toFixed(1).padStart(8)} ${los.pctPositive.toFixed(0).padStart(11)}% ${los.n.toString().padStart(6)}`,
    );
    console.log(
      `  ${"Big losers <-30%".padEnd(20)} ${bl.median.toFixed(1).padStart(8)} ${bl.avg.toFixed(1).padStart(8)} ${bl.pctPositive.toFixed(0).padStart(11)}% ${bl.n.toString().padStart(6)}`,
    );
  };

  analyzeMetric("Revenue Growth YoY (%)", (s) => s.revGrowthYoY);
  analyzeMetric("Operating Margin (%)", (s) => s.operatingMargin);
  analyzeMetric("Margin Change YoY (pp)", (s) => s.marginChangeYoY);
  analyzeMetric("Revenue Acceleration (pp)", (s) => s.revenueAcceleration);
  analyzeMetric("EPS Growth YoY (%)", (s) => s.epsGrowthYoY);
  analyzeMetric("Revenue (MSEK)", (s) => s.revenueMSEK);

  // ─── Top examples ────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log(`TOP 20 BIGGEST WINNERS (6-month forward return)`);
  console.log(`${"═".repeat(70)}`);
  const top20 = [...snapshots]
    .sort((a, b) => b.forwardReturn - a.forwardReturn)
    .slice(0, 20);
  console.log(
    `  ${"Name".padEnd(25)} ${"Date".padEnd(12)} ${"Fwd%".padStart(7)} ${"RevGr".padStart(7)} ${"OpMrg".padStart(7)} ${"MrgΔ".padStart(7)} ${"Accel".padStart(7)}`,
  );
  console.log(`  ${"─".repeat(66)}`);
  for (const s of top20) {
    console.log(
      `  ${s.name.slice(0, 24).padEnd(25)} ${s.date.padEnd(12)} ${s.forwardReturn.toFixed(0).padStart(6)}% ${(s.revGrowthYoY?.toFixed(0) ?? "-").padStart(6)}% ${(s.operatingMargin?.toFixed(0) ?? "-").padStart(6)}% ${(s.marginChangeYoY?.toFixed(0) ?? "-").padStart(6)} ${(s.revenueAcceleration?.toFixed(0) ?? "-").padStart(6)}`,
    );
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  console.log = origLog;
  console.log(`\nOutput: ${OUTPUT_FILE}`);

  await prisma.$disconnect();
};

run().catch(console.error);
