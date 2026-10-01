/**
 * Incremental KPI update — driven by Börsdata's own recalculation clock.
 *
 * Strategy:
 *   1. Ask Börsdata when it last recalculated KPIs Nordic-wide
 *      (GET /instruments/kpis/updated → { kpisCalcUpdated }).
 *   2. Always retry any batch that failed on a previous run first — cheap,
 *      since it's just the specific batches that broke, not everything.
 *   3. If the calc timestamp hasn't changed since our last successful run,
 *      stop there — nothing else changed anywhere.
 *   4. Otherwise, refetch every known KPI combination for every Swedish
 *      instrument, batched 50 instruments per call via the bulk
 *      "instrument array" history endpoint. skipDuplicates makes this
 *      idempotent, so a full refetch naturally catches any period that
 *      a narrower check could miss (e.g. a quarter published mid-year).
 *   5. Only store the new timestamp after a fully successful run.
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
const FAILED_BATCHES_FILE = "./kpi-failed-batches.json";

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
type FailedBatch = Combination & { instrumentIds: number[] };

const loadFailedBatches = (): FailedBatch[] => {
  if (!fs.existsSync(FAILED_BATCHES_FILE)) return [];
  return JSON.parse(fs.readFileSync(FAILED_BATCHES_FILE, "utf-8"));
};

const saveFailedBatches = (batches: FailedBatch[]) => {
  fs.writeFileSync(FAILED_BATCHES_FILE, JSON.stringify(batches));
};

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

const retryFailedBatches = async (
  batches: FailedBatch[],
): Promise<{ totalNew: number; totalErrors: number; apiCalls: number; stillFailing: FailedBatch[] }> => {
  let totalNew = 0;
  let totalErrors = 0;
  let apiCalls = 0;
  const stillFailing: FailedBatch[] = [];

  for (const failed of batches) {
    try {
      const { inserted, errors } = await fetchAndUpsertBatch(
        failed,
        failed.instrumentIds,
      );
      totalNew += inserted;
      totalErrors += errors;
      console.log(
        `  ✓ recovered kpi ${failed.kpiId}/${failed.reportType}/${failed.priceType} (${failed.instrumentIds.length} instruments)`,
      );
    } catch (error: any) {
      console.error(
        `  ✗ still failing: kpi ${failed.kpiId}/${failed.reportType}/${failed.priceType}: ${error.message}`,
      );
      stillFailing.push(failed);
    } finally {
      apiCalls++;
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  return { totalNew, totalErrors, apiCalls, stillFailing };
};

const runFullSweep = async (
  instrumentChunks: number[][],
): Promise<{
  totalNew: number;
  totalErrors: number;
  apiCalls: number;
  stillFailing: FailedBatch[];
}> => {
  let totalNew = 0;
  let totalErrors = 0;
  let apiCalls = 0;
  const stillFailing: FailedBatch[] = [];

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
        stillFailing.push({ ...combination, instrumentIds: chunk });
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

  return { totalNew, totalErrors, apiCalls, stillFailing };
};

async function main() {
  const fullMode = process.argv.includes("--full");

  const { data } = await api.get("/instruments/kpis/updated");
  const kpisCalcUpdated: string = data.kpisCalcUpdated;
  const lastUpdated = loadLastUpdated();

  const previouslyFailed = loadFailedBatches();
  const willSkipFullSweep =
    !fullMode && !!lastUpdated && kpisCalcUpdated === lastUpdated;

  // ─── Skip path: nothing new, but still recover any known failures ─────
  if (willSkipFullSweep) {
    if (previouslyFailed.length === 0) {
      console.log(
        `No new KPI calculations since last run (${lastUpdated}) — nothing to do.`,
      );
      return;
    }

    console.log(
      `Calc timestamp unchanged, but retrying ${previouslyFailed.length} previously failed batch(es)...`,
    );
    const { totalNew, apiCalls, stillFailing } =
      await retryFailedBatches(previouslyFailed);

    saveFailedBatches(stillFailing);
    console.log("");
    console.log(
      `✓ Done — ${totalNew} new KPI records, ${apiCalls} API calls, ${stillFailing.length} batch(es) still failing`,
    );
    return;
  }

  // ─── Full sweep: calc timestamp changed, or --full forced ─────────────
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

  const { totalNew, totalErrors, apiCalls, stillFailing } =
    await runFullSweep(instrumentChunks);

  console.log("");
  console.log(
    `✓ Done — ${totalNew} new KPI records, ${apiCalls} API calls, ${totalErrors} per-instrument errors, ${stillFailing.length} batch(es) still failing`,
  );

  saveFailedBatches(stillFailing);
  saveLastUpdated(kpisCalcUpdated);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
