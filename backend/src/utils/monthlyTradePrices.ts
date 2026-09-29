import { prisma } from "../lib/prisma";

export const extractSellAndBuy = async (
  instrumentId: number,
  startDate: Date,
  endDate: Date,
) => {
  const buyPrice = await prisma.stockPrice.findFirst({
    where: {
      instrumentId,
      date: {
        gte: startDate,
        lt: endDate,
      },
    },

    select: {
      open: true,
      date: true,
    },

    orderBy: {
      date: "asc",
    },
  });

  const sellPrice = await prisma.stockPrice.findFirst({
    where: {
      instrumentId,
      date: {
        gt: startDate,
        lt: endDate, // we sell on first day of next month, update this to lte if we change strat
      },
    },

    select: {
      close: true,
      date: true,
    },

    orderBy: {
      date: "desc",
    },
  });

  return {
    instrumentId,
    buyPrice,
    sellPrice,
  };
};
