import "dotenv/config";
import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { loadProgress, saveProgress } from "../lib/progress";
import { KPI_COMBINATIONS } from "../config/kpiCombinations";
import { z } from "zod";
import { chunkArray } from "../lib/chunks";

/**
 * Seeds KPI values for a specific country using the batch endpoint.
 * Usage: ts-node src/seed/seedKpiValuesGlobal.ts --country=5
 *
 * Uses /v1/Instruments/kpis/{kpiId}/{reportType}/{priceType}/history?instList=...
 * which accepts up to 50 instruments per call.
 */

const BATCH_SIZE = 50; // Max per API call
const DELAY_MS = 110; // ~9 calls/sec to stay under 100/10s limit
const DAILY_LIMIT = 25_000; // One-time large seed, normally keep under 10K
const PROGRESS_FILE_PREFIX = "./kpi-global-progress";

const kpiValueSchema = z.object({
  y: z.number(), // year
  p: z.number().nullable(), // period (quarter)
  v: z.number().nullable(), // value
});

const instrumentKpiSchema = z.object({
  instrument: z.number(),
  values: z.array(kpiValueSchema),
  error: z.string().optional(),
});

const responseSchema = z.object({
  kpiId: z.number(),
  reportTime: z.string(),
  priceValue: z.string(),
  kpisList: z.array(instrumentKpiSchema),
});

export const seedKpiValuesGlobal = async (countryId: number) => {
  const progressFile = `${PROGRESS_FILE_PREFIX}-${countryId}.json`;
  console.log(`Seeding KPI values for country ${countryId}...`);

  const instruments = await prisma.instrument.findMany({
    where: { countryId },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  console.log(
    `Found ${instruments.length} instruments for country ${countryId}`,
  );

  const allIds = instruments.map((i) => i.id);
  const batches = chunkArray(allIds, BATCH_SIZE);

  const completed = loadProgress(progressFile);
  console.log(`${completed.size} combination/batch keys already processed`);

  let totalRecords = 0;
  let callsThisRun = 0;

  for (const combination of KPI_COMBINATIONS) {
    const comboKey = `${combination.kpiId}_${combination.reportType}_${combination.priceType}`;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const key = `${comboKey}_batch${batchIdx}`;
      if (completed.has(key)) continue;

      if (callsThisRun >= DAILY_LIMIT) {
        console.log(
          `\nDaily limit reached (${DAILY_LIMIT} calls). Run again to continue.`,
        );
        console.log(`Total records this run: ${totalRecords}`);
        return;
      }

      const batch = batches[batchIdx];
      const instList = batch.join(",");

      try {
        const response = await api.get(
          `/instruments/kpis/${combination.kpiId}/${combination.reportType}/${combination.priceType}/history`,
          { params: { instList } },
        );

        const parsed = responseSchema.parse(response.data);
        let batchRecords = 0;

        for (const instData of parsed.kpisList) {
          if (instData.error || instData.values.length === 0) continue;

          const records = instData.values
            .filter((v) => v.v !== null)
            .map((v) => ({
              instrumentId: instData.instrument,
              kpiId: combination.kpiId,
              reportType: combination.reportType,
              priceType: combination.priceType,
              year: v.y,
              period: v.p ?? undefined,
              value: v.v ?? undefined,
            }));

          if (records.length > 0) {
            await prisma.kpiValue.createMany({
              data: records,
              skipDuplicates: true,
            });
            batchRecords += records.length;
          }
        }

        totalRecords += batchRecords;
        completed.add(key);
        saveProgress(progressFile, completed);
        callsThisRun++;

        if (callsThisRun % 100 === 0) {
          process.stdout.write(
            `\r  ${callsThisRun} calls | ${totalRecords} records | ${comboKey} batch ${batchIdx + 1}/${batches.length}    `,
          );
        }
      } catch (error: any) {
        if (error?.response?.status === 429) {
          // Rate limited — wait and retry
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "10",
            10,
          );
          console.log(`\n  Rate limited. Waiting ${retryAfter}s...`);
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfter * 1000),
          );
          batchIdx--; // Retry this batch
          continue;
        }
        // Skip other errors
        completed.add(key);
        saveProgress(progressFile, completed);
        callsThisRun++;
      }

      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log(
    `\n✓ Seeded ${totalRecords} KPI records for country ${countryId}`,
  );
};

// CLI entrypoint
if (require.main === module) {
  const countryArg = process.argv.find((a) => a.startsWith("--country="));
  if (!countryArg) {
    console.error("Usage: ts-node src/seed/seedKpiValuesGlobal.ts --country=5");
    process.exit(1);
  }

  const countryId = parseInt(countryArg.split("=")[1], 10);
  seedKpiValuesGlobal(countryId)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
