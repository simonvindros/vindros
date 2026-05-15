import { StockPriceModel } from "../../generated/prisma/models";

export const sma = ({
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

export const linearRegression = (prices: number[]) => {
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

export const averageTrueRange = (prices: StockPriceModel[], days: number) =>
  prices
    .slice(-days)
    .reduce((atr: number[], currentDay, index, sliced) => {
      if (index === 0) {
        atr.push(Number(currentDay.high) - Number(currentDay.low));
      } else {
        const previousDay = sliced[index - 1];
        atr.push(
          Math.max(
            Math.abs(Number(currentDay.high) - Number(currentDay.low)),
            Math.abs(Number(currentDay.high) - Number(previousDay.close)),
            Math.abs(Number(currentDay.low) - Number(previousDay.close)),
          ),
        );
      }
      return atr;
    }, [])
    .reduce((ranges: number, range: number) => ranges + range, 0) / days;
