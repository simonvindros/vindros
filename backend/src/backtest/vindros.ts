import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../lib/prisma";
import { fetchMarketData } from "./fetchMarketData";

type VindrosBacktestConfig = {
  startDate: Date;
  endDate: Date;
  omxId?: number;
  stockUniverseFilter?: {
    countryId: number;
    marketId: number;
  };
  portfolioValue?: number;
  indexValue?: number;
  monthlyContribution?: number;
};

const vindrosBacktest = async ({
  startDate,
  endDate,
  omxId = 638, // OMXSPI
  stockUniverseFilter = {
    countryId: 1, // Sweden
    marketId: 1, // large cap
  },
  portfolioValue = 15_000,
  indexValue = 15_000,
  monthlyContribution = 5_000,
}: VindrosBacktestConfig) => {
  const {
    omxPrices,
    stockUniverse,
    stockPrices,
    stockPricesMap,
    priceInstruments,
    stockNamesByInstrumentId,
  } = await fetchMarketData({
    startDate,
    endDate,
    omxId,
    stockUniverseFilter,
  });
};

vindrosBacktest({
  startDate: new Date("2015-01-01"),
  endDate: new Date("2026-01-01"),
});
