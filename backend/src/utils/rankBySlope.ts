type RegressionResult = {
  slope: number;
  r2: number;
};

type RankedInstrument = {
  instrumentId: number;
  slope: number;
  r2: number;
};

export const rankBySlope = (
  instrumentLinearRegressionMap: Map<number, RegressionResult>,
): RankedInstrument[] =>
  Array.from(instrumentLinearRegressionMap.entries())
    .map(([instrumentId, regression]) => ({
      instrumentId,
      slope: regression.slope,
      r2: regression.r2,
    }))
    .sort((a, b) => b.slope - a.slope);
