export const formatReturnPercentage = (
  buy: number | undefined,
  sell: number | undefined,
): string => {
  if (
    buy === undefined ||
    sell === undefined ||
    !Number.isFinite(buy) ||
    !Number.isFinite(sell) ||
    buy <= 0 ||
    sell <= 0
  ) {
    return "missing price";
  }
  const percentage = ((sell - buy) / buy) * 100;
  const sign = percentage > 0 ? "+" : "";

  return `${sign}${percentage.toFixed(1)}%`;
};

export const formatReturnCash = (
  buy: number | undefined,
  sell: number | undefined,
): string => {
  if (
    buy === undefined ||
    sell === undefined ||
    !Number.isFinite(buy) ||
    !Number.isFinite(sell) ||
    buy <= 0 ||
    sell <= 0
  ) {
    return "missing price";
  }
  const cash = sell - buy;
  const sign = cash > 0 ? "+" : "";

  return `${sign}${cash.toFixed(1)}%`;
};
