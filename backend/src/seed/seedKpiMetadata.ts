import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { z } from "zod";

export const seedKpiMetadata = async () => {
  console.log("Seeding KPI metadata...");

  const response = await api.get("/instruments/kpis/metadata");
  const kpis = response.data.kpiHistoryMetadatas;

  const kpiSchema = z.object({
    kpiId: z.number(),
    nameEn: z.string(),
    nameSv: z.string(),
    format: z.string().nullable(),
    isString: z.boolean(),
  });

  for (const kpi of kpis) {
    const parsedKpi = kpiSchema.parse(kpi);

    await prisma.kpiMetadata.upsert({
      where: { kpiId: parsedKpi.kpiId },
      update: {
        nameEn: parsedKpi.nameEn,
        nameSv: parsedKpi.nameSv,
        format: parsedKpi.format,
        isString: parsedKpi.isString,
      },
      create: {
        kpiId: parsedKpi.kpiId,
        nameEn: parsedKpi.nameEn,
        nameSv: parsedKpi.nameSv,
        format: parsedKpi.format,
        isString: parsedKpi.isString,
      },
    });
  }

  console.log(`✓ Seeded ${kpis.length} KPI metadata entries`);
};
