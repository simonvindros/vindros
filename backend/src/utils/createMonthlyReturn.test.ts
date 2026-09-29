import assert from "node:assert/strict";
import test from "node:test";
import { createMonthlyReturn } from "./createMonthlyReturn";

test("applies the equal-weight return before adding the monthly deposit", () => {
  const stocks = [
    {
      instrumentId: 1,
      companyName: "Winner",
      buyDate: "2026-01-02",
      buyPrice: 100,
      sellDate: "2026-01-30",
      sellPrice: 110,
      winLossCash: "10",
      winLossPercentage: "10%",
    },
    {
      instrumentId: 2,
      companyName: "Loser",
      buyDate: "2026-01-02",
      buyPrice: 100,
      sellDate: "2026-01-30",
      sellPrice: 90,
      winLossCash: "-10",
      winLossPercentage: "-10%",
    },
  ];

  const portfolioValue = createMonthlyReturn(10_000, 10_000, stocks);

  assert.equal(portfolioValue, 20_000);
});
