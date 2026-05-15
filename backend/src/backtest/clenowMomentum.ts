import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../lib/prisma";
import { averageTrueRange, linearRegression, sma } from "./utils";
import { StockPriceModel } from "../../generated/prisma/models";
import { StockPrice } from "../../generated/prisma/client";

const TRADING_DAYS_PER_YEAR = 252;
const TRADING_DAYS_PER_YEAR_IN_MS = TRADING_DAYS_PER_YEAR * 24 * 60 * 60 * 1000;

type ClenowBacktestOptions = {
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
  riskFactor?: number;
};

const clenowMomentumBacktest = async ({
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
  riskFactor = 0.001,
}: ClenowBacktestOptions) => {
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

  const stockPricesUniverse = await prisma.instrument.findMany({
    where: stockUniverseFilter,
  });

  const stockPrices = await prisma.stockPrice.findMany({
    where: {
      instrumentId: {
        in: stockPricesUniverse.map((instrument) => instrument.id),
      },
      date: {
        gte: oneYearEarlier(startDate),
        lte: endDate,
      },
    },
    orderBy: {
      date: "asc",
    },
  });

  const stockPricesByInstrument = stockPrices.reduce<Map<number, StockPrice[]>>(
    (priceMap, stockPrice) => {
      const existing = priceMap.get(stockPrice.instrumentId) || [];
      return priceMap.set(stockPrice.instrumentId, [...existing, stockPrice]);
    },
    new Map(),
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

  const isMarketUptrend = (pricesUpToNow: StockPriceModel[]) => {
    const closes = pricesUpToNow.map((p) => Number(p.close));
    const lastClose = closes[closes.length - 1];
    const sma200 = sma({ days: 200, prices: closes, index: closes.length - 1 });
    return lastClose > sma200;
  };

  const tradingMonths = [
    ...new Set(omxPrices.map((price) => price.date.toISOString().slice(0, 7))),
  ];

  const results: {
    month: string;
    portfolioReturn: number;
    indexReturn: number;
    portfolioValue: number;
    indexValue: number;
    cash: boolean;
    investedPct: number;
  }[] = [];

  for (let i = 0; i < tradingMonths.length - 1; i++) {
    if (i > 0) {
      portfolioValue += monthlyContribution;
      indexValue += monthlyContribution;
    }

    const currentMonth = tradingMonths[i];
    const nextMonth = tradingMonths[i + 1];

    const omxPricesUpToNow = omxPrices.filter(
      (price) => price.date.toISOString().slice(0, 7) < currentMonth,
    );

    const stockPricesUpToNow = Array.from(
      stockPricesByInstrument.entries(),
    ).map(
      ([instrumentId, prices]) =>
        [
          instrumentId,
          prices.filter((p) => p.date.toISOString().slice(0, 7) < currentMonth),
        ] as [number, StockPrice[]],
    );

    let totalReturn = 0;
    let validStocks = 0;
    let isCash = true;
    let investedPct = 0;

    if (isMarketUptrend(omxPricesUpToNow)) {
      isCash = false;
      const REGRESSION_WINDOW = 90;

      const momentumScores = stockPricesUpToNow.map(
        ([instrumentId, prices]) => {
          const closePrices = prices.map((price) => Number(price.close));
          const last90 = closePrices.slice(-REGRESSION_WINDOW);
          const { r2, slope } = linearRegression(last90);

          const annualizedReturnPercentage =
            (Math.exp(slope * TRADING_DAYS_PER_YEAR) - 1) * 100;
          const isAboveSma100 =
            sma({ days: 100, prices: closePrices, index: prices.length - 1 }) <
            closePrices[closePrices.length - 1];
          const score = isAboveSma100 ? r2 * annualizedReturnPercentage : 0;

          return {
            name: stockNamesByInstrumentId.get(instrumentId),
            instrumentId,
            score,
          };
        },
      );

      const rankedByMomentum = momentumScores.sort((a, b) => b.score - a.score);

      const top20 = rankedByMomentum.slice(0, 20);

      const positions: { weight: number; returnPercentage: number }[] = [];

      for (const stock of top20) {
        const instrumentPrices = stockPricesByInstrument.get(
          stock.instrumentId,
        );
        if (!instrumentPrices) continue;

        const pricesUpToBuy = instrumentPrices.filter(
          (p) => p.date.toISOString().slice(0, 7) < currentMonth,
        );
        if (pricesUpToBuy.length < 20) continue;

        const atr = averageTrueRange(pricesUpToBuy, 20);
        if (atr <= 0) continue;

        const lastClose = Number(pricesUpToBuy[pricesUpToBuy.length - 1].close);
        const weight = (riskFactor * lastClose) / atr;

        const buyPrice = Number(
          instrumentPrices.find(
            (price) => price.date.toISOString().slice(0, 7) === currentMonth,
          )?.close,
        );

        const sellPrice = Number(
          instrumentPrices.find(
            (price) => price.date.toISOString().slice(0, 7) === nextMonth,
          )?.close,
        );

        if (buyPrice && sellPrice) {
          const returnPercentage = (sellPrice - buyPrice) / buyPrice;
          positions.push({ weight, returnPercentage });
        }
      }

      // Scale down if total weight > 1 (no leverage)
      const totalWeight = positions.reduce((sum, p) => sum + p.weight, 0);
      const scaleFactor = totalWeight > 1 ? 1 / totalWeight : 1;

      totalReturn = positions.reduce(
        (sum, p) => sum + p.weight * scaleFactor * p.returnPercentage,
        0,
      );
      validStocks = positions.length;
      investedPct = Math.min(totalWeight, 1) * 100;
    }

    const portfolioReturn = validStocks > 0 ? totalReturn : 0;
    portfolioValue *= 1 + portfolioReturn;

    const omxBuy = Number(
      omxPrices.find(
        (price) => price.date.toISOString().slice(0, 7) === currentMonth,
      )?.close,
    );

    const omxSell = Number(
      omxPrices.find(
        (price) => price.date.toISOString().slice(0, 7) === nextMonth,
      )?.close,
    );

    const indexReturn = (omxSell - omxBuy) / omxBuy;
    indexValue *= 1 + indexReturn;

    results.push({
      month: currentMonth,
      portfolioReturn,
      indexReturn,
      portfolioValue,
      indexValue,
      cash: isCash,
      investedPct,
    });
  }
};

clenowMomentumBacktest({
  startDate: new Date("2015-01-01"),
  endDate: new Date("2026-01-01"),
});
