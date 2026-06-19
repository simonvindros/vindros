/**
 * Re-seed KPI history with full 20-year depth (maxCount: 40).
 *
 * The original seed stored ~10 years (2016+) for most instruments.
 * Börsdata API actually has data back to ~2007 for established companies.
 * This script fills the gap for the KPIs used by the quality filter:
 *   - 94  Omsättningstillväxt (Revenue Growth)  — year + quarter
 *   - 53  Omsättning (Revenue)                  — year + quarter
 *   - 29  Rörelsemarginal (Operating Margin)     — year + quarter
 *
 * Safe to run multiple times — uses skipDuplicates.
 *
 * Usage:
 *   cd backend
 *   TS_NODE_COMPILER_OPTIONS='{"rootDir":"."}' npx ts-node src/scripts/reseedKpiHistory.ts
 */

import "dotenv/config";
import { api } from "../lib/api";
import { prisma } from "../lib/prisma";

const DELAY_MS = 50;

// API maxCount limits: year=20, r12/quarter=40
// Only fetching year — quarterly already at max coverage (2016+)
const KPI_TARGETS = [
  { kpiId: 94, reportType: "year", priceType: "mean", maxCount: 20 },
  { kpiId: 53, reportType: "year", priceType: "mean", maxCount: 20 },
  { kpiId: 29, reportType: "year", priceType: "mean", maxCount: 20 },
];

async function main() {
  const instruments = await prisma.instrument.findMany({
    select: { id: true, name: true },
    where: { countryId: 1 },
  });

  console.log(`Re-seeding KPI history for ${instruments.length} instruments`);
  console.log(
    `KPIs: ${KPI_TARGETS.map((k) => `${k.kpiId}/${k.reportType}`).join(", ")}`,
  );

  let totalNew = 0;
  let apiCalls = 0;

  for (const target of KPI_TARGETS) {
    const label = `KPI ${target.kpiId} (${target.reportType})`;
    console.log(`\n--- ${label} ---`);
    let newForKpi = 0;

    for (const inst of instruments) {
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
      } catch (error: any) {
        // Skip instruments without this KPI
      }

      await new Promise((r) => setTimeout(r, DELAY_MS));

      if (apiCalls % 100 === 0) {
        process.stdout.write(
          `  ${apiCalls} API calls, ${inst.name} (${inst.id})...\r`,
        );
      }
    }

    console.log(`  ${label}: +${newForKpi} new records`);
    totalNew += newForKpi;
  }

  console.log(
    `\nDone. ${totalNew} new records inserted (${apiCalls} API calls)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
