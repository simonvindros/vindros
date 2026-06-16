import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { z } from "zod";

const instrumentSchema = z.object({
  insId: z.number(),
  name: z.string(),
  ticker: z.string(),
  isin: z.string().nullable(),
  urlName: z.string().nullable(),
  sectorId: z.number().nullable(),
  marketId: z.number().nullable(),
  branchId: z.number().nullable(),
  countryId: z.number(),
  listingDate: z.string().nullable(),
  stockPriceCurrency: z.string().nullable(),
  reportCurrency: z.string().nullable(),
});

const upsertInstruments = async (instruments: unknown[]) => {
  for (const instrument of instruments) {
    const parsed = instrumentSchema.parse(instrument);

    await prisma.instrument.upsert({
      where: { id: parsed.insId },
      update: {
        name: parsed.name,
        ticker: parsed.ticker,
        isin: parsed.isin,
        urlName: parsed.urlName,
        sectorId: parsed.sectorId,
        marketId: parsed.marketId,
        branchId: parsed.branchId,
        countryId: parsed.countryId,
        listingDate: parsed.listingDate ? new Date(parsed.listingDate) : null,
        stockPriceCurrency: parsed.stockPriceCurrency,
        reportCurrency: parsed.reportCurrency,
      },
      create: {
        id: parsed.insId,
        name: parsed.name,
        ticker: parsed.ticker,
        isin: parsed.isin,
        urlName: parsed.urlName,
        sectorId: parsed.sectorId,
        marketId: parsed.marketId,
        branchId: parsed.branchId,
        countryId: parsed.countryId,
        listingDate: parsed.listingDate ? new Date(parsed.listingDate) : null,
        stockPriceCurrency: parsed.stockPriceCurrency,
        reportCurrency: parsed.reportCurrency,
      },
    });
  }
};

export const seedInstruments = async () => {
  console.log("Seeding Nordic instruments...");
  const nordicResponse = await api.get("/instruments");
  const nordicInstruments = nordicResponse.data.instruments;
  await upsertInstruments(nordicInstruments);
  console.log(`✓ Seeded ${nordicInstruments.length} Nordic instruments`);

  console.log("Seeding global instruments...");
  const globalResponse = await api.get("/instruments/global");
  const globalInstruments = globalResponse.data.instruments;
  await upsertInstruments(globalInstruments);
  console.log(`✓ Seeded ${globalInstruments.length} global instruments`);
};
