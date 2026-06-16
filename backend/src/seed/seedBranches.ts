import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { z } from "zod";

export const seedBranches = async () => {
  console.log("Seeding branches...");
  const response = await api.get("/branches");
  const branches = response.data.branches;

  const branchSchema = z.object({
    id: z.number(),
    name: z.string(),
    sectorId: z.number(),
  });

  for (const branch of branches) {
    const parsed = branchSchema.parse(branch);
    await prisma.branch.upsert({
      where: { branchId: parsed.id },
      update: { name: parsed.name, sectorId: parsed.sectorId },
      create: {
        branchId: parsed.id,
        name: parsed.name,
        sectorId: parsed.sectorId,
      },
    });
  }

  console.log(`✓ Seeded ${branches.length} branches`);
};
