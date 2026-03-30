import dotenv from "dotenv";
dotenv.config();
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  await prisma.stockPrice.deleteMany();
  console.log("✓ StockPrice table cleared");
  await prisma.$disconnect();
}

main();
