import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { loadProgress, saveProgress } from "../lib/progress";
import { KPI_COMBINATIONS } from "../config/kpiCombinations";
import { z } from "zod";

const KPI_PROGRESS_FILE = "./kpi-progress.json";
const DAILY_LIMIT = 9000;
const DELAY_MS = 50;

export const seedKpiValues = async () => {
  console.log("Seeding KPI values...");

  const instruments = await prisma.instrument.findMany({
    select: { id: true },
    where: { countryId: 1 },
  });

  const completed = loadProgress(KPI_PROGRESS_FILE);
  console.log(
    `${completed.size} KPI/instrument combinations already processed`,
  );

  let totalRecords = 0;
  let callsThisRun = 0;

  for (const combination of KPI_COMBINATIONS) {
    for (const instrument of instruments) {
      const key = `${combination.kpiId}_${combination.reportType}_${combination.priceType}_${instrument.id}`;

      if (completed.has(key)) continue;

      if (callsThisRun >= DAILY_LIMIT) {
        console.log(
          `Daily limit reached. Run npm run seed again tomorrow to continue.`,
        );
        return;
      }

      try {
        const response = await api.get(
          `/instruments/${instrument.id}/kpis/${combination.kpiId}/${combination.reportType}/${combination.priceType}/history`,
        );

        const values = response.data.values;

        if (values && values.length > 0) {
          const records = values.map((v: any) => ({
            instrumentId: instrument.id,
            kpiId: combination.kpiId,
            reportType: combination.reportType,
            priceType: combination.priceType,
            year: v.y,
            period: v.p ?? null,
            value: v.v ?? null,
          }));

          await prisma.kpiValue.createMany({
            data: records,
            skipDuplicates: true,
          });

          totalRecords += records.length;
        }

        // Mark as complete regardless of whether there was data
        completed.add(key);
        saveProgress(KPI_PROGRESS_FILE, completed);
        callsThisRun++;
      } catch (error) {
        // Silently skip — instrument may not have this KPI
        console.log(`Skipping ${key} due to error:`, error);
      }

      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log(`✓ Seeded ${totalRecords} KPI records this run`);
};
