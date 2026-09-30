import { api } from "../lib/api";
import { chunkArray } from "../lib/chunks";
import { prisma } from "../lib/prisma";
import { loadProgress, saveProgress } from "../lib/progress";
import { z } from "zod";

const STOCK_PROGRESS_FILE = "./stock-progress.json";

export const seedStockPrices = async (countryId?: number) => {
  const label = countryId ? `country ${countryId}` : "all";
  console.log(`Seeding stock prices (${label})...`);

  const where = countryId ? { countryId } : undefined;
  const instruments = await prisma.instrument.findMany({
    select: { id: true },
    where,
  });

  const ids = instruments.map((i) => i.id);
  const chunks = chunkArray(ids, 10);
  const completedIds = loadProgress(STOCK_PROGRESS_FILE);
  saveProgress(STOCK_PROGRESS_FILE, completedIds);

  console.log(`${completedIds.size} instruments already processed`);

  let totalRecords = 0;
  const BATCH_LIMIT = 500; // Process max 500 batches per run
  let batchesProcessed = 0;

  const priceScehma = z.object({
    d: z.string(), // date
    o: z.number().nullable(), // open
    h: z.number().nullable(), // high
    l: z.number().nullable(), // low
    c: z.number().nullable(), // close
    v: z.number().nullable(), // volume
  });

  const instrumentDataSchema = z.object({
    instrument: z.number(),
    stockPricesList: z.array(priceScehma),
  });

  const responseSchema = z.object({
    stockPricesArrayList: z.array(instrumentDataSchema),
  });

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

      const stockPricesArrayList = responseSchema.parse(
        response.data,
      ).stockPricesArrayList;

      for (const instrumentData of stockPricesArrayList) {
        const records = instrumentData.stockPricesList.map((price) => ({
          instrumentId: instrumentData.instrument,
          date: new Date(price.d),
          open: price.o ?? 0,
          high: price.h ?? 0,
          low: price.l ?? 0,
          close: price.c ?? 0,
          volume: price.v == null ? BigInt(0) : BigInt(price.v),
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
    } catch (error) {
      console.error(`Batch ${i + 1} failed:`, error);
    } finally {
      batchesProcessed++;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`✓ Seeded ${totalRecords} new stock price records`);
};
