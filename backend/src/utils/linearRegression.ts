const TRADING_DAYS_PER_YEAR = 252;
const VARIANCE_EPSILON = 1e-12;

export const linearRegression = (
  prices: number[],
): { slope: number; r2: number } => {
  if (
    prices.length < 2 ||
    prices.some((price) => !Number.isFinite(price) || price <= 0)
  ) {
    return { slope: 0, r2: 0 };
  }

  const logPrices = prices.map((price) => Math.log(price));
  const n = logPrices.length;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += logPrices[i];
    sumXY += i * logPrices[i];
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return { slope: 0, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;

  let totalSumOfSquares = 0;
  let residualSumOfSquares = 0;

  for (let i = 0; i < n; i++) {
    const residual = logPrices[i] - (slope * i + intercept);
    totalSumOfSquares += (logPrices[i] - meanY) ** 2;
    residualSumOfSquares += residual ** 2;
  }

  // R² is undefined for a flat series; treat it as no trend.
  const r2 =
    totalSumOfSquares <= VARIANCE_EPSILON
      ? 0
      : 1 - residualSumOfSquares / totalSumOfSquares;

  return { slope: slope * TRADING_DAYS_PER_YEAR, r2 };
};
