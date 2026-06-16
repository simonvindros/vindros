import dotenv from "dotenv";
dotenv.config();
import { seedCountries } from "./seedCountries";
import { seedMarkets } from "./seedMarkets";
import { seedSectors } from "./seedSectors";
import { seedBranches } from "./seedBranches";
import { seedInstruments } from "./seedInstruments";
import { seedKpiMetadata } from "./seedKpiMetadata";
import { seedStockPrices } from "./seedStockPrices";
import { prisma } from "../lib/prisma";
import { seedKpiValues } from "./seedKpiValues";

const main = async () => {
  try {
    await seedCountries();
    await seedMarkets();
    await seedSectors();
    await seedBranches();
    await seedInstruments();
    await seedKpiMetadata();
    await seedStockPrices();
    await seedKpiValues();

    console.log("✓ Seeding complete!");
  } catch (error) {
    console.error("Seeding failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

main();
