import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as fs from "fs";
const PROGRESS_FILE = "./seed-progress.json";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const api = axios.create({
  baseURL: "https://apiservice.borsdata.se/v1",
  params: {
    authKey: process.env.BORSDATA_API_KEY,
  },
});

async function seedCountries() {
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
}

async function seedMarkets() {
  console.log("Seeding markets...");
  const response = await api.get("/markets");
  const markets = response.data.markets;

  for (const market of markets) {
    await prisma.market.upsert({
      where: { marketId: market.id },
      update: {
        name: market.name,
        countryId: market.countryId,
        isIndex: market.isIndex,
        exchangeName: market.exchangeName,
      },
      create: {
        marketId: market.id,
        name: market.name,
        countryId: market.countryId,
        isIndex: market.isIndex,
        exchangeName: market.exchangeName,
      },
    });
  }
  console.log(`✓ Seeded ${markets.length} markets`);
}

async function seedSectors() {
  console.log("Seeding sectors...");
  const response = await api.get("/sectors");
  const sectors = response.data.sectors;

  for (const sector of sectors) {
    await prisma.sector.upsert({
      where: { sectorId: sector.id },
      update: { name: sector.name },
      create: { sectorId: sector.id, name: sector.name },
    });
  }
  console.log(`✓ Seeded ${sectors.length} sectors`);
}

async function seedKpiMetadata() {
  console.log("Seeding KPI metadata...");
  const response = await api.get("/instruments/kpis/metadata");
  const kpis = response.data.kpiHistoryMetadatas;

  for (const kpi of kpis) {
    await prisma.kpiMetadata.upsert({
      where: { kpiId: kpi.kpiId },
      update: {
        nameEn: kpi.nameEn,
        nameSv: kpi.nameSv,
        format: kpi.format,
        isString: kpi.isString,
      },
      create: {
        kpiId: kpi.kpiId,
        nameEn: kpi.nameEn,
        nameSv: kpi.nameSv,
        format: kpi.format,
        isString: kpi.isString,
      },
    });
  }
  console.log(`✓ Seeded ${kpis.length} KPI metadata entries`);
}

async function seedInstruments() {
  console.log("Seeding instruments...");
  const response = await api.get("/instruments");
  const instruments = response.data.instruments;

  for (const instrument of instruments) {
    await prisma.instrument.upsert({
      where: { id: instrument.insId },
      update: {
        name: instrument.name,
        ticker: instrument.ticker,
        isin: instrument.isin,
        urlName: instrument.urlName,
        sectorId: instrument.sectorId,
        marketId: instrument.marketId,
        branchId: instrument.branchId,
        countryId: instrument.countryId,
        listingDate: instrument.listingDate
          ? new Date(instrument.listingDate)
          : null,
        stockPriceCurrency: instrument.stockPriceCurrency,
        reportCurrency: instrument.reportCurrency,
      },
      create: {
        id: instrument.insId,
        name: instrument.name,
        ticker: instrument.ticker,
        isin: instrument.isin,
        urlName: instrument.urlName,
        sectorId: instrument.sectorId,
        marketId: instrument.marketId,
        branchId: instrument.branchId,
        countryId: instrument.countryId,
        listingDate: instrument.listingDate
          ? new Date(instrument.listingDate)
          : null,
        stockPriceCurrency: instrument.stockPriceCurrency,
        reportCurrency: instrument.reportCurrency,
      },
    });
  }
  console.log(`✓ Seeded ${instruments.length} instruments`);
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function loadProgress(): Set<number> {
  if (fs.existsSync(PROGRESS_FILE)) {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    return new Set(data);
  }
  return new Set();
}

function saveProgress(completedIds: Set<number>) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...completedIds]));
}

async function seedStockPrices() {
  console.log("Seeding stock prices...");

  const instruments = await prisma.instrument.findMany({
    select: { id: true },
  });

  const ids = instruments.map((i) => i.id);
  const chunks = chunkArray(ids, 10);
  const completedIds = loadProgress();

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

    if (chunk.every((id) => completedIds.has(id))) {
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
      chunk.forEach((id) => completedIds.add(id));
      saveProgress(completedIds);
      batchesProcessed++;
    } catch (error) {
      console.error(`Batch ${i + 1} failed:`, error);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`✓ Seeded ${totalRecords} new stock price records`);
}

async function main() {
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
}

main();
