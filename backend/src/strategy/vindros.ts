import "dotenv/config";
import { prisma } from "../lib/prisma";
import { linearRegression } from "../utils/linearRegression";
import { rankBySlope } from "../utils/rankBySlope";
import { formatReturnCash, formatReturnPercentage } from "../utils/winAndLoss";
import { getMonthlyOpenAndClose } from "../utils/monthlyTradePrices";
import { createMonthRanges } from "../utils/createMonthRanges";
import { calculateEndOfMonthPortfolioValue } from "../utils/calculateEndOfMonthPortfolioValue";

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

      const instrumentIdBuyAndSell = new Map<
        number,
        {
          companyName?: string;
          buy: { date: string; price: number };
          sell: { date: string; price: number };
        }
      >();

      for (const instrument of topTen) {
        const companyName = await prisma.instrument.findUnique({
          where: {
            id: instrument.instrumentId,
          },
          select: {
            name: true,
          },
        });
        const { instrumentId, monthlyOpen, monthlyClose } =
          await getMonthlyOpenAndClose(
            instrument.instrumentId,
            month.start,
            month.end,
          );
        instrumentIdBuyAndSell.set(instrumentId, {
          companyName: companyName?.name,
          buy: {
            date: new Date(monthlyOpen?.date ?? "").toDateString(),
            price: Number(monthlyOpen?.open),
          },
          sell: {
            date: new Date(monthlyClose?.date ?? "").toDateString(),
            price: Number(monthlyClose?.close),
          },
        });
      }

      const buyAndSellPricePerInstrument = topTen.map(({ instrumentId }) => ({
        instrumentId,
        companyName: instrumentIdBuyAndSell.get(instrumentId)?.companyName,
        buyDate: instrumentIdBuyAndSell.get(instrumentId)?.buy.date,
        buyPrice: instrumentIdBuyAndSell.get(instrumentId)?.buy.price,
        sellDate: instrumentIdBuyAndSell.get(instrumentId)?.sell.date,
        sellPrice: instrumentIdBuyAndSell.get(instrumentId)?.sell.price,
        winLossCash: formatReturnCash(
          instrumentIdBuyAndSell.get(instrumentId)?.buy.price,
          instrumentIdBuyAndSell.get(instrumentId)?.sell.price,
        ),
        winLossPercentage: formatReturnPercentage(
          instrumentIdBuyAndSell.get(instrumentId)?.buy.price,
          instrumentIdBuyAndSell.get(instrumentId)?.sell.price,
        ),
      }));

      console.table(buyAndSellPricePerInstrument, [
        "instrumentId",
        "companyName",
        "buyDate",
        "buyPrice",
        "sellDate",
        "sellPrice",
        "winLossCash",
        "winLossPercentage",
      ]);

      portfolioValue = calculateEndOfMonthPortfolioValue(
        portfolioValue,
        monthlyDeposit,
        buyAndSellPricePerInstrument.map((instrument) => ({
          instrumentId: instrument.instrumentId,
          buyPrice: instrument.buyPrice,
          sellPrice: instrument.sellPrice,
        })),
      );
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
