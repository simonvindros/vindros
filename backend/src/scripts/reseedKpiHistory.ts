/**
 * Re-seed KPI history with full depth for ALL report types.
 *
 * - year:    maxCount=20 → 20 years back (~2006/2007)
 * - r12:     maxCount=40 → 10 years back (~2016)
 * - quarter: maxCount=40 → 10 years back (~2016)
 *
 * The original global seed may have gaps or shallower history.
 * This script ensures every instrument has full coverage for every KPI.
 *
 * Safe to run multiple times — uses skipDuplicates + resumable progress.
 *
 * Usage:
 *   cd backend
 *   npm run reseed:kpis
 */

import "dotenv/config";
import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { KPI_COMBINATIONS } from "../config/kpiCombinations";
import { loadProgress, saveProgress } from "../lib/progress";

const DELAY_MS = 110; // ~9 calls/sec, safely under Börsdata's 100/10s limit
const PROGRESS_FILE = "./reseed-kpi-progress.json";

// Extract ALL unique KPI targets from KPI_COMBINATIONS
const KPI_TARGETS = Array.from(
  new Map(
    KPI_COMBINATIONS
      .map((c) => [`${c.kpiId}_${c.reportType}_${c.priceType}`, c])
  ).values()
).map((c) => ({
  ...c,
  maxCount: c.reportType === "year" ? 20 : 40,
}));

async function main() {
  const instruments = await prisma.instrument.findMany({
    select: { id: true, name: true },
    where: { countryId: { in: [1, 2, 3, 4] } },
  });

  const completed = loadProgress(PROGRESS_FILE);

  const totalTarget = KPI_TARGETS.length * instruments.length;
  console.log(`Re-seeding KPI history for ${instruments.length} instruments`);
  console.log(`${KPI_TARGETS.length} unique KPI combinations (year/r12/quarter)`);
  console.log(`${completed.size} already completed — resuming...`);
  console.log(`Remaining: ~${totalTarget - completed.size} API calls`);
  console.log(`At ${DELAY_MS}ms delay, ETA ~${Math.ceil((totalTarget - completed.size) * DELAY_MS / 3600000)} hours`);

  let totalNew = 0;
  let apiCalls = 0;

  for (const target of KPI_TARGETS) {
    const label = `KPI ${target.kpiId} (${target.reportType}/${target.priceType})`;
    let newForKpi = 0;

    for (const inst of instruments) {
      const key = `${target.kpiId}_${target.reportType}_${target.priceType}_${inst.id}`;
      if (completed.has(key)) continue;

      try {
        const response = await api.get(
          `/instruments/${inst.id}/kpis/${target.kpiId}/${target.reportType}/${target.priceType}/history`,
          { params: { maxCount: target.maxCount } },
        );
        apiCalls++;

        const values = response.data.values;
        if (values && values.length > 0) {
          const records = values
            .filter((v: any) => v.v !== null && v.v !== undefined)
            .map((v: any) => ({
              instrumentId: inst.id,
              kpiId: target.kpiId,
              reportType: target.reportType,
              priceType: target.priceType,
              year: v.y,
              period: v.p ?? undefined,
              value: v.v,
            }));

          const result = await prisma.kpiValue.createMany({
            data: records,
            skipDuplicates: true,
          });

          newForKpi += result.count;
        }

        // Only mark completed on success (including empty responses — instrument genuinely has no data)
        completed.add(key);
        saveProgress(PROGRESS_FILE, completed);
      } catch (error: any) {
        const status = error?.response?.status;
        if (status === 404) {
          // Instrument genuinely doesn't have this KPI — mark done
          completed.add(key);
          saveProgress(PROGRESS_FILE, completed);
        } else {
          // Network error, rate limit, server error — do NOT mark done, will retry on next run
          console.error(`  ✗ ${inst.name} (${inst.id}) KPI ${target.kpiId}: ${error.message}`);
        }
      }

      await new Promise((r) => setTimeout(r, DELAY_MS));

      if (apiCalls % 100 === 0) {
        process.stdout.write(
          `  [${label}] ${apiCalls} calls, ${inst.name}... +${newForKpi} new\r`,
        );
      }
    }

    if (newForKpi > 0) {
      console.log(`  ${label}: +${newForKpi} new records`);
    }
    totalNew += newForKpi;
  }

  console.log(
    `\nDone. ${totalNew} new records inserted (${apiCalls} API calls)`,
  );
  await prisma.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
