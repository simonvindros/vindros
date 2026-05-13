import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../lib/prisma";

const clenowMomentumBacktest = async () => {
  const dailyClosePricesForYear = await prisma.stockPrice.findMany({
    where: {
      instrumentId: 638, // OMXSPi
      date: {
        gte: new Date(Date.now() - 250 * 24 * 60 * 60 * 1000),
        lte: new Date(Date.now()),
      },
    },
    orderBy: {
      date: "asc",
    },
  });

  const closePrices = dailyClosePricesForYear.map((price) =>
    Number(price.close),
  );

  const sma = ({
    days,
    prices,
    index,
  }: {
    days: number;
    prices: number[];
    index: number;
  }): number => {
    const window = prices.slice(Math.max(0, index - days), index + 1);
    const sum = window.reduce((acc, price) => acc + price, 0);
    return sum / window.length;
  };

  const lastIndex = closePrices.length - 1;
  const currentSma200 = sma({
    days: 200,
    prices: closePrices,
    index: lastIndex,
  });
  const lastClose = closePrices[lastIndex];

  const marketIsUptrend = lastClose > currentSma200;

  console.log(
    `OMXSPI: ${lastClose} | SMA200: ${currentSma200.toFixed(2)} | Market: ${marketIsUptrend ? "UPTREND" : "DOWNTREND"}`,
  );

  if (!marketIsUptrend) {
    console.log("Market filter: go to cash. No positions.");
    return;
  }

  const stockUniverse = await prisma.instrument.findMany({
    where: {
      countryId: 1, // Sweden
      marketId: 1, // large cap
    },
  });

  const instrumentNames = new Map(
    stockUniverse.map((instrument) => [instrument.id, instrument.name]),
  );

  const prices = await prisma.stockPrice.findMany({
    where: {
      close: {
        gt: 5,
      },
      instrumentId: {
        in: stockUniverse.map((inst) => inst.id),
      },
      date: {
        gte: new Date(Date.now() - 150 * 24 * 60 * 60 * 1000),
      },
    },
    orderBy: {
      date: "asc",
    },
  });

  const linearRegression = (prices: number[]) => {
    if (prices.length < 60) {
      return { r2: 0, slope: 0 };
    }

    const yAxis = prices.map((price) => Math.log(price));
    const xAxis = prices.map((_, index) => index);

    const n = prices.length;
    const sumX = xAxis.reduce((sumOfX, x) => sumOfX + x, 0);
    const sumY = yAxis.reduce((sumOfY, y) => sumOfY + y, 0);
    const sumXY = xAxis.reduce(
      (sumOfXY, x, index) => sumOfXY + x * yAxis[index],
      0,
    );
    const sumX2 = xAxis.reduce((sumOfX2, x) => sumOfX2 + x * x, 0);
    const sumY2 = yAxis.reduce((sumOfY2, y) => sumOfY2 + y * y, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - Math.pow(sumX, 2));
    const r2 =
      Math.pow(n * sumXY - sumX * sumY, 2) /
      ((n * sumX2 - Math.pow(sumX, 2)) * (n * sumY2 - Math.pow(sumY, 2)));
    return { r2, slope };
  };

  const pricesByInstrument = new Map(
    prices.reduce((map, price) => {
      const existing = map.get(price.instrumentId) || [];
      return map.set(price.instrumentId, [...existing, Number(price.close)]);
    }, new Map()),
  );

  const momentumScores = Array.from(pricesByInstrument.entries()).map(
    ([instrumentId, prices]) => {
      const { r2, slope } = linearRegression(prices);

      const annualizedReturnPercentage = (Math.exp(slope * 252) - 1) * 100;
      const isAboveSma100 =
        sma({ days: 100, prices, index: prices.length - 1 }) <
        prices[prices.length - 1];
      const score = isAboveSma100 ? r2 * annualizedReturnPercentage : 0;

      return {
        name: instrumentNames.get(instrumentId),
        instrumentId,
        score,
      };
    },
  );

  const rankedByMomentum = momentumScores.sort((a, b) => b.score - a.score);

  console.log(
    "🚀 ~ clenowMomentumBacktest ~ rankedByMomentum:",
    rankedByMomentum.slice(0, 20),
  );
};

clenowMomentumBacktest();
