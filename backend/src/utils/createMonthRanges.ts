type MonthRange = {
  start: Date;
  end: Date;
};

export const createMonthRanges = (
  startDate: Date,
  asOfDate: Date,
): MonthRange[] => {
  const ranges: MonthRange[] = [];

  let monthStart = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1),
  );
  const endExclusive = new Date(
    Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), 1),
  );

  while (monthStart < endExclusive) {
    const nextMonthStart = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1),
    );

    ranges.push({
      start: monthStart,
      end: nextMonthStart,
    });

    monthStart = nextMonthStart;
  }

  return ranges;
};
