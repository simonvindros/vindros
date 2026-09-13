import "dotenv/config";
import { prisma } from "../lib/prisma";
import { linearRegression } from "../utils/linearRegression";
import { rankBySlope } from "../utils/rankBySlope";

const executeVindros = async (countryId: number, marketIds: number[]) => {
  try {
    const instrumentLinearRegressionMap = new Map();

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

        const companyName = await prisma.instrument.findUnique({
          where: {
            id: instrument.id,
          },
          select: {
            name: true,
          },
        });

        const closePrices = (await prices).map((price) => Number(price.close));
        const chronologicalPrices = closePrices.reverse();
        const linReg = linearRegression(chronologicalPrices);

        if (linReg.r2 >= 0.6)
          instrumentLinearRegressionMap.set(companyName?.name, linReg);
      }
    }
    console.log(
      Array.from(rankBySlope(instrumentLinearRegressionMap)).splice(0, 10),
    );
  } finally {
    await prisma.$disconnect();
  }
};

executeVindros(1, [1, 2]);
