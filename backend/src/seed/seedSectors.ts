import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { z } from "zod";

export const seedSectors = async () => {
  console.log("Seeding sectors...");
  const response = await api.get("/sectors");
  const sectors = response.data.sectors;

  const sectorSchema = z.object({
    id: z.number(),
    name: z.string(),
  });

  for (const sector of sectors) {
    const parsedSector = sectorSchema.parse(sector);
    await prisma.sector.upsert({
      where: { sectorId: parsedSector.id },
      update: { name: parsedSector.name },
      create: { sectorId: parsedSector.id, name: parsedSector.name },
    });
  }

  console.log(`✓ Seeded ${sectors.length} sectors`);
};
