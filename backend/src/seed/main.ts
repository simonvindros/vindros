import dotenv from "dotenv";
import { seedCountries } from "./seedCountries";
import { seedMarkets } from "./seedMarkets";
import { seedSectors } from "./seedSectors";
import { seedInstruments } from "./seedInstruments";
import { seedKpiMetadata } from "./seedKpiMetadata";
import { seedStockPrices } from "./seedStockPrices";
import { prisma } from "../lib/prisma";

dotenv.config();

const main = async () => {
  try {
    await seedCountries();
    await seedMarkets();
    await seedSectors();
    await seedInstruments();
    await seedKpiMetadata();
    await seedStockPrices();

    console.log("✓ Seeding complete!");
  } catch (error) {
    console.error("Seeding failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

main();
