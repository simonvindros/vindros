import { prisma } from "../lib/prisma";

export const getMonthlyOpenAndClose = async (
  instrumentId: number,
  startDate: Date,
  endDate: Date,
) => {
  const monthlyOpen = await prisma.stockPrice.findFirst({
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

  const monthlyClose = await prisma.stockPrice.findFirst({
    where: {
      instrumentId,
      date: {
        gt: startDate,
        lt: endDate,
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
    monthlyOpen,
    monthlyClose,
  };
};
