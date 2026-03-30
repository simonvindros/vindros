import { api } from "../lib/api";
import { prisma } from "../lib/prisma";

export const seedKpiMetadata = async () => {
  console.log("Seeding KPI metadata...");

  const response = await api.get("/instruments/kpis/metadata");
  const kpis = response.data.kpiHistoryMetadatas;

  for (const kpi of kpis) {
    await prisma.kpiMetadata.upsert({
      where: { kpiId: kpi.kpiId },
      update: {
        nameEn: kpi.nameEn,
        nameSv: kpi.nameSv,
        format: kpi.format,
        isString: kpi.isString,
      },
      create: {
        kpiId: kpi.kpiId,
        nameEn: kpi.nameEn,
        nameSv: kpi.nameSv,
        format: kpi.format,
        isString: kpi.isString,
      },
    });
  }

  console.log(`✓ Seeded ${kpis.length} KPI metadata entries`);
};
