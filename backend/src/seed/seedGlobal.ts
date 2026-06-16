import dotenv from "dotenv";
dotenv.config();

import { seedInstruments } from "./seedInstruments";
import { seedCountries } from "./seedCountries";
import { seedMarkets } from "./seedMarkets";
import { seedSectors } from "./seedSectors";
import { seedBranches } from "./seedBranches";
import { seedStockPrices } from "./seedStockPrices";
import { prisma } from "../lib/prisma";

const main = async () => {
  const countryArg = process.argv.find((a) => a.startsWith("--country="));
  const countryId = countryArg
    ? parseInt(countryArg.split("=")[1], 10)
    : undefined;

  if (!countryId) {
    console.error("Usage: ts-node src/seed/seedGlobal.ts --country=5");
    console.error(
      "Country IDs: 1=Sverige, 2=Norge, 3=Finland, 4=Danmark, 5=USA",
    );
    process.exit(1);
  }

  try {
    console.log(`Seeding data for country ${countryId}...\n`);

    // Reference data (needed for FK constraints)
    await seedCountries();
    await seedMarkets();
    await seedSectors();
    await seedBranches();

    // Instruments (fetches both Nordic + global, upserts all)
    await seedInstruments();

    // Prices only for the specified country
    await seedStockPrices(countryId);

    console.log("\n✓ Done!");
  } catch (error) {
    console.error("Seeding failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

main();
