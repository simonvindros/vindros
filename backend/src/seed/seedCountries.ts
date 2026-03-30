import { api } from "../lib/api";
import { prisma } from "../lib/prisma";

export const seedCountries = async () => {
  console.log("Seeding countries...");

  const response = await api.get("/countries");
  const countries = response.data.countries;

  for (const country of countries) {
    await prisma.country.upsert({
      where: { countryId: country.id },
      update: { name: country.name },
      create: { countryId: country.id, name: country.name },
    });
  }

  console.log(`✓ Seeded ${countries.length} countries`);
};
