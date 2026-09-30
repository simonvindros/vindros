/**
 * Incremental KPI update — driven by Börsdata's own recalculation clock.
 *
 * Strategy:
 *   1. Ask Börsdata when it last recalculated KPIs Nordic-wide
 *      (GET /instruments/kpis/updated → { kpisCalcUpdated }).
 *   2. If that timestamp hasn't changed since our last successful run,
 *      nothing changed anywhere — exit immediately.
 *   3. Otherwise, refetch every known KPI combination for every Swedish
 *      instrument, batched 50 instruments per call via the bulk
 *      "instrument array" history endpoint. skipDuplicates makes this
 *      idempotent, so a full refetch naturally catches any period that
 *      a narrower check could miss (e.g. a quarter published mid-year).
 *   4. Only store the new timestamp after a fully successful run.
 *
 * For initial seeding, use: npm run seed / npm run reseed:kpis
 *
 * Usage:
 *   npm run update:kpis            (skip if Börsdata hasn't recalculated)
 *   npm run update:kpis -- --full  (ignore the timestamp check, always refetch)
 */
import dotenv from "dotenv";
dotenv.config();

import * as fs from "node:fs";
import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { chunkArray } from "../lib/chunks";
import { KPI_COMBINATIONS } from "../config/kpiCombinations";

const DELAY_MS = 110; // ~9 calls/sec, under Börsdata's documented 10/sec limit
const INSTRUMENT_BATCH_SIZE = 50; // API max for the bulk history endpoint
const LAST_UPDATED_FILE = "./kpi-last-updated.json";

const loadLastUpdated = (): string | null => {
  if (!fs.existsSync(LAST_UPDATED_FILE)) return null;
  return JSON.parse(fs.readFileSync(LAST_UPDATED_FILE, "utf-8")).lastUpdated;
};

const saveLastUpdated = (timestamp: string) => {
  fs.writeFileSync(
    LAST_UPDATED_FILE,
    JSON.stringify({ lastUpdated: timestamp }),
  );
};

type Combination = (typeof KPI_COMBINATIONS)[number];

const fetchAndUpsertBatch = async (
  combination: Combination,
  instrumentIds: number[],
): Promise<{ inserted: number; errors: number }> => {
  const maxCount = combination.reportType === "year" ? 20 : 40;

  const response = await api.get(
    `/instruments/kpis/${combination.kpiId}/${combination.reportType}/${combination.priceType}/history`,
    { params: { instList: instrumentIds.join(","), maxCount } },
  );

  const kpisList = response.data.kpisList ?? [];
  let inserted = 0;
  let errors = 0;

  for (const entry of kpisList) {
    if (entry.error) {
      errors++;
      continue;
    }

    const values = entry.values ?? [];
    const records = values
      .filter((v: any) => v.v !== null && v.v !== undefined)
      .map((v: any) => ({
        instrumentId: entry.instrument,
        kpiId: combination.kpiId,
        reportType: combination.reportType,
        priceType: combination.priceType,
        year: v.y,
        period: v.p ?? 0,
        value: v.v,
      }));

    if (records.length === 0) continue;

    const result = await prisma.kpiValue.createMany({
      data: records,
      skipDuplicates: true,
    });
    inserted += result.count;
  }

  return { inserted, errors };
};

async function main() {
  const fullMode = process.argv.includes("--full");

  const { data } = await api.get("/instruments/kpis/updated");
  const kpisCalcUpdated: string = data.kpisCalcUpdated;

  const lastUpdated = loadLastUpdated();
  if (!fullMode && lastUpdated && kpisCalcUpdated === lastUpdated) {
    console.log(
      `No new KPI calculations since last run (${lastUpdated}) — nothing to do.`,
    );
    return;
  }

  console.log(`Börsdata KPI calc timestamp: ${kpisCalcUpdated}`);
  console.log(
    `Mode: ${fullMode ? "FULL (forced)" : "Calc timestamp changed — refetching all combos"}`,
  );
  console.log("");

  const instruments = await prisma.instrument.findMany({
    select: { id: true },
    where: { countryId: 1 }, // Sweden only
  });
  const instrumentChunks = chunkArray(
    instruments.map((i) => i.id),
    INSTRUMENT_BATCH_SIZE,
  );

  console.log(
    `  ${instruments.length} Swedish instruments in ${instrumentChunks.length} batch(es) of ${INSTRUMENT_BATCH_SIZE}`,
  );
  console.log(`  ${KPI_COMBINATIONS.length} KPI combinations`);
  console.log("");

  // ─── Fetch and insert ─────────────────────────────────────────────────
  let totalNew = 0;
  let apiCalls = 0;
  let totalErrors = 0;

  for (const combination of KPI_COMBINATIONS) {
    for (const chunk of instrumentChunks) {
      try {
        const { inserted, errors } = await fetchAndUpsertBatch(
          combination,
          chunk,
        );
        totalNew += inserted;
        totalErrors += errors;
      } catch (error: any) {
        console.error(
          `  ✗ kpi ${combination.kpiId}/${combination.reportType}/${combination.priceType} batch failed: ${error.message}`,
        );
      } finally {
        apiCalls++;
      }

      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    if (apiCalls % 500 === 0 && apiCalls > 0) {
      console.log(
        `  [${apiCalls} API calls] +${totalNew} new rows, ${totalErrors} per-instrument errors`,
      );
    }
  }

  console.log("");
  console.log(
    `✓ Done — ${totalNew} new KPI records, ${apiCalls} API calls, ${totalErrors} per-instrument errors`,
  );

  saveLastUpdated(kpisCalcUpdated);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
