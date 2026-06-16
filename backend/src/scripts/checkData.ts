import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../lib/prisma";

async function main() {
  const byCntry = await prisma.$queryRaw<any[]>`
    SELECT i."countryId", c.name, COUNT(*)::int as count
    FROM "Instrument" i
    JOIN "Country" c ON c."countryId" = i."countryId"
    GROUP BY i."countryId", c.name
    ORDER BY count DESC
    LIMIT 10
  `;
  console.log("Instruments by country:");
  console.table(byCntry);

  const sectors = await prisma.sector.findMany({
    orderBy: { sectorId: "asc" },
  });
  console.log(`\nAll sectors (${sectors.length}):`);
  sectors.forEach((s) => console.log(`  ${s.sectorId}: ${s.name}`));

  const usBySector = await prisma.$queryRaw<any[]>`
    SELECT s."sectorId", s.name, COUNT(*)::int as count
    FROM "Instrument" i
    JOIN "Sector" s ON s."sectorId" = i."sectorId"
    WHERE i."countryId" = 5
    GROUP BY s."sectorId", s.name
    ORDER BY count DESC
  `;
  console.log("\nUS instruments by sector:");
  console.table(usBySector);

  const usPriceCount = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*)::int as price_rows
    FROM "StockPrice" sp
    JOIN "Instrument" i ON i.id = sp."instrumentId"
    WHERE i."countryId" = 5
  `;
  console.log("\nUS price data:", usPriceCount);

  // Global coverage
  const globalPriceCount = await prisma.$queryRaw<any[]>`
    SELECT c.name, COUNT(DISTINCT sp."instrumentId")::int as instruments_with_prices
    FROM "StockPrice" sp
    JOIN "Instrument" i ON i.id = sp."instrumentId"
    JOIN "Country" c ON c."countryId" = i."countryId"
    GROUP BY c.name
    ORDER BY instruments_with_prices DESC
    LIMIT 15
  `;
  console.log("\nInstruments with price data by country:");
  console.table(globalPriceCount);

  await prisma.$disconnect();
}

main();
