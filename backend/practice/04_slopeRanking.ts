/**
 * EXERCISE 4: Slope Ranking
 *
 * Problem:
 * Given a list of stocks with their price histories, compute the momentum
 * signal (slope + R²) for each, apply filters, and return the top N ranked
 * by slope descending.
 *
 * This is what the backtest does every month to select the portfolio.
 *
 * Requirements:
 *   1. For each stock, compute linearRegression on the last REG_WINDOW prices
 *   2. Filter out stocks where:
 *      - price < MIN_PRICE
 *      - R² < MIN_R2
 *      - fewer than MIN_DATA_POINTS prices available
 *   3. Rank remaining stocks by slope (highest first)
 *   4. Return the top TOTAL_POSITIONS stocks
 *
 * Use your linearRegression from exercise 3 (imported for you below).
 */

// ─── Configuration ───────────────────────────────────────────────────────────
const TOTAL_POSITIONS = 15;
const REG_WINDOW = 90;
const MIN_PRICE = 10;
const MIN_R2 = 0.6;
const MIN_DATA_POINTS = 60;

// ─── Types ───────────────────────────────────────────────────────────────────
type Stock = {
  id: number;
  name: string;
  prices: number[]; // daily closing prices, most recent LAST
};

type RankedStock = {
  id: number;
  name: string;
  price: number; // latest price (last element of prices array)
  slope: number; // annualized slope
  r2: number;
};

// ─── Your linearRegression from exercise 3 (paste your solution here) ────────
function linearRegression(prices: number[]): { slope: number; r2: number } {
  if (prices.length < 2) return { slope: 0, r2: 0 };

  const n = prices.length;
  const logPrices = prices.map((p) => Math.log(p));

  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += logPrices[i];
    sumXY += i * logPrices[i];
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const meanY = sumY / n;
  let ssTot = 0,
    ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * i + intercept;
    ssTot += (logPrices[i] - meanY) ** 2;
    ssRes += (logPrices[i] - predicted) ** 2;
  }

  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope: slope * 252, r2 };
}

// ─── Implement this ──────────────────────────────────────────────────────────
function getTopStocks(stocks: Stock[]): RankedStock[] {
  stocks.map((prices, i, arr) => {
    // const linReg =
  });
  // YOUR CODE HERE
  // 1. For each stock, take the last REG_WINDOW prices (or fewer if not enough)
  // 2. Compute linearRegression
  // 3. Apply filters (MIN_DATA_POINTS, MIN_PRICE, MIN_R2)
  // 4. Sort by slope descending
  // 5. Return top TOTAL_POSITIONS
  return [];
}

// ─── Tests ───────────────────────────────────────────────────────────────────
function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`✗ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

// Generate mock stock data
function mockStock(
  id: number,
  name: string,
  dailyGrowth: number,
  days: number,
  startPrice = 100,
): Stock {
  const prices = Array.from(
    { length: days },
    (_, i) => startPrice * Math.exp(i * dailyGrowth),
  );
  return { id, name, prices };
}

const stocks: Stock[] = [
  mockStock(1, "RocketUp", 0.008, 100), // strong uptrend, slope ≈ 2.0
  mockStock(2, "SteadyGrower", 0.004, 100), // moderate uptrend, slope ≈ 1.0
  mockStock(3, "SlowPoke", 0.001, 100), // weak uptrend, slope ≈ 0.25
  mockStock(4, "PennyStock", 0.006, 100, 5), // good trend but price < 10
  mockStock(5, "NewListing", 0.005, 30), // too few data points (< 60)
  mockStock(6, "Downtrend", -0.003, 100), // negative slope
  mockStock(7, "MidGrower", 0.005, 100), // good uptrend, slope ≈ 1.26
  mockStock(8, "BigCap", 0.003, 100, 500), // moderate, high price
  mockStock(9, "Volatile", 0.002, 100), // will be enhanced with noise below
];

// Make stock 9 volatile (low R²) — inject noise
stocks[8].prices = stocks[8].prices.map((p, i) => p + (i % 2 === 0 ? 20 : -20));

const result = getTopStocks(stocks);

// Test 1: PennyStock filtered (price < 10)
assert(
  !result.find((s) => s.name === "PennyStock"),
  "PennyStock filtered (< MIN_PRICE)",
);

// Test 2: NewListing filtered (< 60 data points)
assert(
  !result.find((s) => s.name === "NewListing"),
  "NewListing filtered (< MIN_DATA_POINTS)",
);

// Test 3: Downtrend filtered (slope < 0 means R² won't save it from being below top N)
assert(
  !result.find((s) => s.name === "Downtrend"),
  "Downtrend not in top (negative slope)",
);

// Test 4: Volatile likely filtered (R² < 0.6)
assert(
  !result.find((s) => s.name === "Volatile"),
  "Volatile filtered (R² < MIN_R2)",
);

// Test 5: Top stock should be RocketUp (highest slope)
assert(result.length > 0, "result is not empty");
assert(
  result[0].name === "RocketUp",
  `#1 is RocketUp (got: ${result[0]?.name})`,
);

// Test 6: Correct ordering (slope descending)
for (let i = 1; i < result.length; i++) {
  assert(
    result[i].slope <= result[i - 1].slope,
    `#${i + 1} ${result[i].name} slope (${result[i].slope.toFixed(2)}) ≤ #${i} (${result[i - 1].slope.toFixed(2)})`,
  );
}

// Test 7: Max TOTAL_POSITIONS results
assert(result.length <= TOTAL_POSITIONS, `result length ≤ ${TOTAL_POSITIONS}`);

// Test 8: Each result has the correct latest price
const rocketUp = result.find((s) => s.name === "RocketUp");
if (rocketUp) {
  const expectedPrice = stocks[0].prices[stocks[0].prices.length - 1];
  assert(
    Math.abs(rocketUp.price - expectedPrice) < 0.01,
    `RocketUp price matches last price (${rocketUp.price.toFixed(1)})`,
  );
}

console.log("\n🎉 All tests passed!");
console.log("\n📝 Questions:");
console.log("   1. What's the time complexity of getTopStocks?");
console.log(
  "      (Consider: N stocks × regression on W prices each, then sorting)",
);
console.log(
  "   2. In the real system, we process ~2,269 stocks with 90-day windows.",
);
console.log("      Is this fast enough? (Calculate: 2269 × 90 operations)");

export {};
