/**
 * SECTOR CONCENTRATION — Are we just buying tech?
 *
 * Tags every pick with its sector, reports distribution over time.
 * If one sector dominates → the "momentum signal" might just be a sector bet.
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
import { prisma } from "../lib/prisma";

const OUTPUT_FILE = path.join(__dirname, "sector_analysis_output.txt");
const lines: string[] = [];
const log = (msg = "") => {
  lines.push(msg);
  console.log(msg);
};

const run = async () => {
  log("Loading data...");
  const data = await loadEngineData();

  // Load sector mappings
  const instruments = await prisma.instrument.findMany({
    select: { id: true, sectorId: true },
  });
  const sectorMap = new Map<number, number | null>(
    instruments.map((i) => [i.id, i.sectorId]),
  );

  const sectors = await prisma.sector.findMany();
  const sectorNames = new Map<number, string>(
    sectors.map((s) => [s.sectorId, s.name]),
  );

  log(
    `Loaded. ${data.monthEnds.length} month-ends, ${sectorNames.size} sectors.`,
  );
  log("");

  let qualifiedSmallCaps = new Set<number>();
  let lastQualifyKey = 0;

  // Track sector picks per month
  const sectorCounts: Map<string, number> = new Map(); // sector name → total months picked
  const monthlySectorDist: Array<Map<string, number>> = []; // per month: sector → count

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
    const { allocations } = allocatePositions(
      data,
      allCandidates,
      1_000_000,
      day,
    );

    const monthSectors = new Map<string, number>();
    for (const a of allocations) {
      const secId = sectorMap.get(a.instrumentId);
      const secName = secId
        ? sectorNames.get(secId) || `Sector ${secId}`
        : "Unknown";
      monthSectors.set(secName, (monthSectors.get(secName) || 0) + 1);
      sectorCounts.set(secName, (sectorCounts.get(secName) || 0) + 1);
    }
    monthlySectorDist.push(monthSectors);
  }

  const totalPicks = [...sectorCounts.values()].reduce((s, v) => s + v, 0);
  const sortedSectors = [...sectorCounts.entries()].sort((a, b) => b[1] - a[1]);

  log("═".repeat(90));
  log("SECTOR CONCENTRATION ANALYSIS");
  log("═".repeat(90));
  log(
    `Period: ${data.monthEnds[0]} to ${data.monthEnds[data.monthEnds.length - 1]} (${data.monthEnds.length} months)`,
  );
  log(`Total position-months: ${totalPicks}`);
  log("");

  log("─".repeat(90));
  log("SECTOR DISTRIBUTION (all picks, all months):");
  log("─".repeat(90));
  log(
    `  ${"Sector".padEnd(35)} ${"Picks".padStart(8)} ${"% of Total".padStart(12)} ${"Bar".padStart(3)}`,
  );
  log("  " + "─".repeat(70));
  for (const [name, count] of sortedSectors) {
    const pct = (count / totalPicks) * 100;
    const bar = "█".repeat(Math.round(pct / 2));
    log(
      `  ${name.padEnd(35)} ${String(count).padStart(8)} ${(pct.toFixed(1) + "%").padStart(12)} ${bar}`,
    );
  }

  // Concentration metrics
  const top1Pct = (sortedSectors[0][1] / totalPicks) * 100;
  const top3Pct =
    (sortedSectors.slice(0, 3).reduce((s, [, c]) => s + c, 0) / totalPicks) *
    100;
  const hhi = sortedSectors.reduce((s, [, c]) => s + (c / totalPicks) ** 2, 0);

  log("");
  log("─".repeat(90));
  log("CONCENTRATION METRICS:");
  log("─".repeat(90));
  log(
    `  Top 1 sector:                  ${sortedSectors[0][0]} (${top1Pct.toFixed(1)}%)`,
  );
  log(`  Top 3 sectors:                 ${top3Pct.toFixed(1)}% of all picks`);
  log(
    `  HHI (Herfindahl index):        ${(hhi * 10000).toFixed(0)} (>2500 = concentrated, <1500 = diversified)`,
  );
  log(`  Effective number of sectors:   ${(1 / hhi).toFixed(1)} (1/HHI)`);
  log("");

  // Time evolution: show sector dominance per year
  log("─".repeat(90));
  log("SECTOR DOMINANCE BY YEAR:");
  log("─".repeat(90));
  const yearSectors = new Map<number, Map<string, number>>();
  for (let mi = 0; mi < data.monthEnds.length; mi++) {
    const year = parseInt(data.monthEnds[mi].slice(0, 4));
    if (!yearSectors.has(year)) yearSectors.set(year, new Map());
    const ys = yearSectors.get(year)!;
    for (const [sec, cnt] of monthlySectorDist[mi]) {
      ys.set(sec, (ys.get(sec) || 0) + cnt);
    }
  }

  log(
    `  ${"Year".padEnd(6)} ${"Top Sector".padEnd(30)} ${"% of Year".padStart(10)} ${"2nd Sector".padEnd(25)} ${"% ".padStart(6)}`,
  );
  log("  " + "─".repeat(80));
  for (const [year, sectors] of [...yearSectors.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const sorted = [...sectors.entries()].sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, c]) => s + c, 0);
    const top = sorted[0];
    const second = sorted[1];
    log(
      `  ${String(year).padEnd(6)} ${top[0].padEnd(30)} ${(((top[1] / total) * 100).toFixed(0) + "%").padStart(10)} ${(second ? second[0] : "—").padEnd(25)} ${second ? (((second[1] / total) * 100).toFixed(0) + "%").padStart(6) : "".padStart(6)}`,
    );
  }

  log("");
  log("─".repeat(90));
  log("INTERPRETATION:");
  log("─".repeat(90));
  if (top1Pct > 50) {
    log(
      `  WARNING: ${sortedSectors[0][0]} accounts for >${top1Pct.toFixed(0)}% of all picks.`,
    );
    log(
      "  This strategy may be a disguised sector bet. Consider neutralizing.",
    );
  } else if (top3Pct > 75) {
    log("  MODERATE CONCENTRATION: Top 3 sectors dominate.");
    log(
      "  The signal works across a few sectors but is not broadly diversified.",
    );
  } else {
    log("  DIVERSIFIED: No single sector dominates the signal.");
    log(
      "  The momentum signal appears to work across the market, not just one sector.",
    );
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
