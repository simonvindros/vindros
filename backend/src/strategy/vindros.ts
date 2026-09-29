import "dotenv/config";
import { prisma } from "../lib/prisma";
import { linearRegression } from "../utils/linearRegression";
import { rankBySlope } from "../utils/rankBySlope";
import { formatReturnCash, formatReturnPercentage } from "../utils/winAndLoss";
import { extractSellAndBuy } from "../utils/monthlyTradePrices";
import { createMonthRanges } from "../utils/createMonthRanges";

const executeVindros = async (
  startingAmount: number,
  monthlyDeposit: number,
  countryId: number,
  marketIds: number[],
  startDate: Date,
  endDate: Date,
) => {
  try {
    let portfolioValue = startingAmount;

    const months = createMonthRanges(startDate, endDate);

    for (const month of months) {
      const instrumentLinearRegressionMap = new Map<
        number,
        { slope: number; r2: number }
      >();

      for (const marketId of marketIds) {
        const instruments = await prisma.instrument.findMany({
          where: {
            countryId,
            marketId,
          },
        });

        for (const instrument of instruments) {
          const prices = prisma.stockPrice.findMany({
            where: {
              instrumentId: instrument.id,
              date: {
                lt: month.start,
              },
            },

            select: {
              date: true,
              close: true,
              open: true,
              high: true,
              low: true,
              instrumentId: true,
              volume: true,
            },

            orderBy: {
              date: "desc",
            },

            take: 60,
          });

          const closePrices = (await prices).map((price) =>
            Number(price.close),
          );
          if (closePrices.length !== 60) continue;
          const chronologicalPrices = closePrices.reverse();
          const linReg = linearRegression(chronologicalPrices);

          if (linReg.r2 >= 0.6)
            instrumentLinearRegressionMap.set(instrument.id, linReg);
        }
      }

      const topTen = rankBySlope(instrumentLinearRegressionMap).slice(0, 10);

      const instrumentIdBuyPrice = new Map<
        number,
        { date: string; price: number }
      >();

      for (const instrument of topTen) {
        const { instrumentId, buyPrice } = await extractSellAndBuy(
          instrument.instrumentId,
          month.start,
          month.end,
        );
        instrumentIdBuyPrice.set(instrumentId, {
          date: new Date(buyPrice?.date ?? "").toDateString(),
          price: Number(buyPrice?.open),
        });
      }

      const instrumentIdSellPrice = new Map<
        number,
        { date: string; price: number }
      >();

      for (const instrument of topTen) {
        const { instrumentId, sellPrice } = await extractSellAndBuy(
          instrument.instrumentId,
          month.start,
          month.end,
        );
        instrumentIdSellPrice.set(instrumentId, {
          date: new Date(sellPrice?.date ?? "").toDateString(),
          price: Number(sellPrice?.close),
        });
      }

      // TODO: replace id with company name later
      for (const instrument of topTen) {
        const companyName = await prisma.instrument.findUnique({
          where: {
            id: instrument.instrumentId,
          },
          select: {
            name: true,
          },
        });
      }

      const buyAndSellPricePerInstrument = topTen.map(({ instrumentId }) => ({
        instrumentId,
        buyDate: instrumentIdBuyPrice.get(instrumentId)?.date,
        buy: instrumentIdBuyPrice.get(instrumentId)?.price,
        sellDate: instrumentIdSellPrice.get(instrumentId)?.date,
        sell: instrumentIdSellPrice.get(instrumentId)?.price,
        winLossCash: formatReturnCash(
          instrumentIdBuyPrice.get(instrumentId)?.price,
          instrumentIdSellPrice.get(instrumentId)?.price,
        ),
        winLossPercentage: formatReturnPercentage(
          instrumentIdBuyPrice.get(instrumentId)?.price,
          instrumentIdSellPrice.get(instrumentId)?.price,
        ),
      }));

      const monthlyReturn =
        buyAndSellPricePerInstrument.reduce((sum, stock) => {
          const { buy, sell, instrumentId } = stock;

          if (
            buy === undefined ||
            sell === undefined ||
            !Number.isFinite(buy) ||
            !Number.isFinite(sell) ||
            buy <= 0
          ) {
            throw new Error(
              `Missing or invalid price for instrument ${instrumentId}`,
            );
          }

          return sum + (sell / buy - 1);
        }, 0) / buyAndSellPricePerInstrument.length;

      portfolioValue *= 1 + monthlyReturn;

      portfolioValue += monthlyDeposit;
    }

    console.table(portfolioValue);
  } finally {
    await prisma.$disconnect();
  }
};

executeVindros(
  10000,
  10000,
  1,
  [1, 2],
  new Date("2020-01-01T00:00:00.000Z"),
  new Date("2020-03-01T00:00:00.000Z"),
);
