import dotenv from "dotenv";
dotenv.config();

import { api } from "../lib/api";
import { prisma } from "../lib/prisma";

const getWeekdays = (start: Date, end: Date): string[] => {
  const dates: string[] = [];
  const current = new Date(start);
  current.setDate(current.getDate() + 1); // start from day after latest

  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(current.toISOString().slice(0, 10));
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

const backfillGap = async () => {
  const result = await prisma.$queryRaw<[{ min_date: Date }]>`
    SELECT MIN(latest)::date as min_date FROM (
      SELECT "instrumentId", MAX(date) as latest
      FROM "StockPrice"
      GROUP BY "instrumentId"
    ) sub
  `;

  const latestDate = result[0]?.min_date;

  if (!latestDate) {
    console.log("  No existing prices — skipping backfill");
    return;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const dates = getWeekdays(latestDate, yesterday);

  if (dates.length === 0) {
    console.log("  Prices are up to date — no gap to fill");
    return;
  }

  console.log(`  Backfilling ${dates.length} days: ${dates[0]} → ${dates[dates.length - 1]}`);
  let totalInserted = 0;

  for (const date of dates) {
    try {
      const response = await api.get("/instruments/stockprices/date", {
        params: { date },
      });

      const prices = response.data.stockPricesList;

      if (!prices || prices.length === 0) {
        console.log(`    ${date} — no data (holiday)`);
        continue;
      }

      const records = prices.map((price: any) => ({
        instrumentId: price.i,
        date: new Date(price.d),
        open: price.o ?? 0,
        high: price.h ?? 0,
        low: price.l ?? 0,
        close: price.c ?? 0,
        volume: price.v != null ? BigInt(price.v) : BigInt(0),
      }));

      const inserted = await prisma.stockPrice.createMany({
        data: records,
        skipDuplicates: true,
      });

      totalInserted += inserted.count;
      console.log(`    ${date} ✓ ${inserted.count} inserted`);
    } catch (error: any) {
      console.error(`    ${date} ✗ ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`  ✓ Backfilled ${totalInserted} records`);
}

const fetchLatest = async () => {
  console.log("  Fetching latest prices...");
  const response = await api.get("/instruments/stockprices/last");
  const prices = response.data.stockPricesList;

  const records = prices.map((price: any) => ({
    instrumentId: price.i,
    date: new Date(price.d),
    open: price.o ?? 0,
    high: price.h ?? 0,
    low: price.l ?? 0,
    close: price.c ?? 0,
    volume: price.v != null ? BigInt(price.v) : BigInt(0),
  }));

  const inserted = await prisma.stockPrice.createMany({
    data: records,
    skipDuplicates: true,
  });

  console.log(`  ✓ ${inserted.count} latest records inserted`);
}

const main = async () => {
  try {
    console.log("Updating stock prices...\n");

    // Phase 1: backfill any gap up to yesterday
    await backfillGap();

    // Phase 2: fetch today's latest
    await fetchLatest();

    console.log("\n✓ Done!");
  } catch (error) {
    console.error("Update failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

main();
