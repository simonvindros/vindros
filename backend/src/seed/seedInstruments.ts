import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { z } from "zod";

export const seedInstruments = async () => {
  console.log("Seeding instruments...");

  const response = await api.get("/instruments");
  const instruments = response.data.instruments;

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

  for (const instrument of instruments) {
    const parsedInstrument = instrumentSchema.parse(instrument);

    await prisma.instrument.upsert({
      where: { id: parsedInstrument.insId },
      update: {
        name: parsedInstrument.name,
        ticker: parsedInstrument.ticker,
        isin: parsedInstrument.isin,
        urlName: parsedInstrument.urlName,
        sectorId: parsedInstrument.sectorId,
        marketId: parsedInstrument.marketId,
        branchId: parsedInstrument.branchId,
        countryId: parsedInstrument.countryId,
        listingDate: parsedInstrument.listingDate
          ? new Date(parsedInstrument.listingDate)
          : null,
        stockPriceCurrency: parsedInstrument.stockPriceCurrency,
        reportCurrency: parsedInstrument.reportCurrency,
      },
      create: {
        id: parsedInstrument.insId,
        name: parsedInstrument.name,
        ticker: parsedInstrument.ticker,
        isin: parsedInstrument.isin,
        urlName: parsedInstrument.urlName,
        sectorId: parsedInstrument.sectorId,
        marketId: parsedInstrument.marketId,
        branchId: parsedInstrument.branchId,
        countryId: parsedInstrument.countryId,
        listingDate: parsedInstrument.listingDate
          ? new Date(parsedInstrument.listingDate)
          : null,
        stockPriceCurrency: parsedInstrument.stockPriceCurrency,
        reportCurrency: parsedInstrument.reportCurrency,
      },
    });
  }

  console.log(`✓ Seeded ${instruments.length} instruments`);
};
