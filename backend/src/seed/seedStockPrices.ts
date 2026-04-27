import { api } from "../lib/api";
import { chunkArray } from "../lib/chunks";
import { prisma } from "../lib/prisma";
import { loadProgress, saveProgress } from "../lib/progress";

const STOCK_PROGRESS_FILE = "./stock-progress.json";

// Then everywhere you call loadProgress/saveProgress:

export const seedStockPrices = async () => {
  console.log("Seeding stock prices...");

  const instruments = await prisma.instrument.findMany({
    select: { id: true },
  });

  const ids = instruments.map((i) => i.id);
  const chunks = chunkArray(ids, 10);
  const completedIds = loadProgress(STOCK_PROGRESS_FILE);
  saveProgress(STOCK_PROGRESS_FILE, completedIds);

  console.log(`${completedIds.size} instruments already processed`);

  let totalRecords = 0;
  const BATCH_LIMIT = 20; // Process max 20 batches per run
  let batchesProcessed = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (batchesProcessed >= BATCH_LIMIT) {
      console.log("Batch limit reached, run npm run seed again to continue...");
      break;
    }

    const chunk = chunks[i];

    if (chunk.every((id) => completedIds.has(String(id)))) {
      console.log(
        `Batch ${i + 1}/${chunks.length} already seeded, skipping...`,
      );
      continue;
    }

    console.log(`Processing batch ${i + 1}/${chunks.length}...`);

    try {
      const response = await api.get("/instruments/stockprices", {
        params: { instList: chunk.join(",") },
      });

      const stockPricesArrayList = response.data.stockPricesArrayList;

      for (const instrumentData of stockPricesArrayList) {
        const records = instrumentData.stockPricesList.map((price: any) => ({
          instrumentId: instrumentData.instrument,
          date: new Date(price.d),
          open: price.o ?? 0,
          high: price.h ?? 0,
          low: price.l ?? 0,
          close: price.c ?? 0,
          volume: price.v != null ? BigInt(price.v) : BigInt(0),
        }));

        await prisma.stockPrice.createMany({
          data: records,
          skipDuplicates: true,
        });

        totalRecords += records.length;
      }

      // Only mark as complete after successful insert
      chunk.forEach((id) => completedIds.add(String(id)));

      saveProgress(STOCK_PROGRESS_FILE, completedIds);
      batchesProcessed++;
    } catch (error) {
      console.error(`Batch ${i + 1} failed:`, error);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`✓ Seeded ${totalRecords} new stock price records`);
};
