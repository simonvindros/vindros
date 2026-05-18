import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../lib/prisma";

type MarketDataOptions = {
  startDate: Date;
  endDate: Date;
  omxId?: number;
  stockUniverseFilter?: {
    countryId: number;
    marketId: number;
  };
};

export const fetchMarketData = async ({
  startDate,
  endDate,
  omxId,
  stockUniverseFilter,
}: MarketDataOptions) => {
  const oneYearEarlier = (date: Date) =>
    new Date(date.getTime() - 12 * 30 * 24 * 60 * 60 * 1000);

  const omxPrices = await prisma.stockPrice.findMany({
    where: {
      instrumentId: omxId,
      date: {
        gte: oneYearEarlier(startDate),
        lte: endDate,
      },
    },
    orderBy: {
      date: "asc",
    },
  });

  const stockUniverse = await prisma.instrument.findMany({
    where: stockUniverseFilter,
  });

  const stockPrices = await prisma.stockPrice.findMany({
    where: {
      instrumentId: {
        in: stockUniverse.map((instrument) => instrument.id),
      },
    },
  });

  const stockPricesMap = new Map(
    stockPrices.reduce((priceMap, stockPrice) => {
      const existing = priceMap.get(stockPrice.instrumentId) || [];
      return priceMap.set(stockPrice.instrumentId, [...existing, stockPrice]);
    }, new Map()),
  );

  const priceInstruments = await prisma.instrument.findMany({
    where: {
      id: {
        in: stockPrices.map((price) => price.instrumentId),
      },
    },
  });

  const stockNamesByInstrumentId = new Map(
    priceInstruments.map((instrument) => [instrument.id, instrument.name]),
  );

  return {
    omxPrices,
    stockUniverse,
    stockPrices,
    stockPricesMap,
    priceInstruments,
    stockNamesByInstrumentId,
  };
};
