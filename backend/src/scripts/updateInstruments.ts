/**
 * Update instruments — picks up new IPOs/listings from Börsdata.
 * Safe to re-run anytime (uses upsert).
 */
import dotenv from "dotenv";
dotenv.config();

import { seedInstruments } from "../seed/seedInstruments";
import { prisma } from "../lib/prisma";

const run = async () => {
  await seedInstruments();
  await prisma.$disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
