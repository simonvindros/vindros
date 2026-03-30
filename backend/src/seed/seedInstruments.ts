import { api } from "../lib/api";
import { prisma } from "../lib/prisma";

export const seedInstruments = async () => {
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
};
