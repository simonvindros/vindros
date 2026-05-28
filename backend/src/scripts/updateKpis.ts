/**
 * Update KPI values for the 3 KPIs used by Vindros fundamental filter.
 * Unlike the full seed (which goes through ALL combinations), this only
 * fetches revenue growth, operating margin, and revenue — both yearly and quarterly.
 */
import dotenv from "dotenv";
dotenv.config();

import { api } from "../lib/api";
import { prisma } from "../lib/prisma";

const KPI_REVENUE_GROWTH = 94;
const KPI_OPERATING_MARGIN = 29;
const KPI_REVENUE = 53;

const COMBINATIONS = [
  { kpiId: KPI_REVENUE_GROWTH, reportType: "year", priceType: "mean" },
  { kpiId: KPI_REVENUE_GROWTH, reportType: "quarter", priceType: "mean" },
  { kpiId: KPI_OPERATING_MARGIN, reportType: "year", priceType: "mean" },
  { kpiId: KPI_OPERATING_MARGIN, reportType: "quarter", priceType: "mean" },
  { kpiId: KPI_REVENUE, reportType: "year", priceType: "mean" },
  { kpiId: KPI_REVENUE, reportType: "quarter", priceType: "mean" },
];

const DELAY_MS = 100;

export const updateKpis = async () => {
  console.log("Updating KPI values (revenue growth, op margin, revenue)...\n");

  const instruments = await prisma.instrument.findMany({
    select: { id: true },
    where: { countryId: 1 },
  });

  let totalUpserted = 0;
  let apiCalls = 0;

  for (const combo of COMBINATIONS) {
    const label = `KPI ${combo.kpiId} / ${combo.reportType}`;
    let comboCount = 0;

    for (const instrument of instruments) {
      try {
        const response = await api.get(
          `/instruments/${instrument.id}/kpis/${combo.kpiId}/${combo.reportType}/${combo.priceType}/history`,
        );

        const values = response.data.values;
        if (values && values.length > 0) {
          const records = values
            .filter((v: any) => v.v !== null)
            .map((v: any) => ({
              instrumentId: instrument.id,
              kpiId: combo.kpiId,
              reportType: combo.reportType,
              priceType: combo.priceType,
              year: v.y,
              period: v.p ?? 0,
              value: v.v,
            }));

          await prisma.kpiValue.createMany({
            data: records,
            skipDuplicates: true,
          });

          comboCount += records.length;
        }

        apiCalls++;
      } catch {
        // Instrument may not have this KPI — skip silently
      }

      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }

    totalUpserted += comboCount;
    console.log(`  ${label}: ${comboCount} values`);
  }

  console.log(
    `\n✓ Updated ${totalUpserted} KPI records (${apiCalls} API calls)`,
  );
};

// Run directly
if (require.main === module) {
  updateKpis()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
