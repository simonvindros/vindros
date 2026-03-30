import { api } from "../lib/api";
import { prisma } from "../lib/prisma";

export const seedSectors = async () => {
  console.log("Seeding sectors...");
  const response = await api.get("/sectors");
  const sectors = response.data.sectors;

  for (const sector of sectors) {
    await prisma.sector.upsert({
      where: { sectorId: sector.id },
      update: { name: sector.name },
      create: { sectorId: sector.id, name: sector.name },
    });
  }

  console.log(`✓ Seeded ${sectors.length} sectors`);
};
