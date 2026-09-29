export const calculateEndOfMonthPortfolioValue = (
  portfolioValue: number,
  monthlyDeposit: number,
  stocks: {
    instrumentId: number;
    buyPrice: number | undefined;
    sellPrice: number | undefined;
  }[],
) => {
  const avgReturnPerStock =
    stocks.reduce((sum, stock) => {
      const { buyPrice, sellPrice, instrumentId } = stock;

      if (stocks.length === 0) {
        throw new Error(`
              Stock length is 0
          `);
      }

      if (
        buyPrice === undefined ||
        sellPrice === undefined ||
        !Number.isFinite(buyPrice) ||
        !Number.isFinite(sellPrice) ||
        buyPrice <= 0
      ) {
        throw new Error(
          `Missing or invalid price for instrument ${instrumentId}`,
        );
      }

      return sum + (sellPrice / buyPrice - 1);
    }, 0) / stocks.length;

  portfolioValue *= 1 + avgReturnPerStock;

  portfolioValue += monthlyDeposit;

  return portfolioValue;
};
