import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { z } from "zod";

export const seedCountries = async () => {
  console.log("Seeding countries...");

  const response = await api.get("/countries");
  const countries = response.data.countries;

  const countrySchema = z.object({
    id: z.number(),
    name: z.string(),
  });

  for (const country of countries) {
    const parsedCountry = countrySchema.parse(country);
    await prisma.country.upsert({
      where: { countryId: parsedCountry.id },
      update: { name: parsedCountry.name },
      create: { countryId: parsedCountry.id, name: parsedCountry.name },
    });
  }

  console.log(`✓ Seeded ${countries.length} countries`);
};
