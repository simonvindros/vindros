/**
 * EXERCISE 3: Linear Regression
 *
 * This is THE core math behind the Vindros momentum signal.
 *
 * Problem:
 * Given an array of closing prices (one per trading day), compute:
 *   - slope: how fast the price is rising (daily rate in log space)
 *   - r2: how consistent the trend is (0 = random, 1 = perfect line)
 *
 * The Math (step by step):
 *
 * 1. Take the natural log of each price: y[i] = ln(price[i])
 *    Why log? Because a stock going from 100→200 (+100%) should look the same
 *    as 200→400 (+100%). In log space, both are the same distance (ln(2) ≈ 0.69).
 *    Without log, the 200→400 move would dominate the regression unfairly.
 *
 * 2. x values are just day indices: x = [0, 1, 2, ..., n-1]
 *
 * 3. Fit a line y = mx + b using least squares:
 *
 *    slope (m) = (n * Σ(xi*yi) - Σxi * Σyi) / (n * Σ(xi²) - (Σxi)²)
 *
 *    This minimizes the sum of squared vertical distances from each point
 *    to the line. It's the "best fit" line through the log-prices.
 *
 * 4. Compute R² (coefficient of determination):
 *
 *    ȳ = mean of all y values
 *    SS_tot = Σ(yi - ȳ)²     — total variance in the data
 *    SS_res = Σ(yi - ŷi)²    — variance NOT explained by the line
 *                               where ŷi = m*xi + b (predicted value)
 *
 *    R² = 1 - (SS_res / SS_tot)
 *
 *    If R² = 1: every point lies exactly on the line (perfect trend)
 *    If R² = 0: the line explains nothing (random noise)
 *
 * 5. Annualize the slope: multiply by 252 (trading days per year)
 *    A daily slope of 0.004 → annualized ≈ 1.0 → ~100% annual growth
 *
 * Return: { slope: annualized_slope, r2: r_squared }
 * If prices has fewer than 2 elements, return { slope: 0, r2: 0 }
 */

function linearRegression(prices: number[]): { slope: number; r2: number } {
  if (prices.length < 2) return { slope: 0, r2: 0 };
  // YOUR CODE HERE
  const logOfPrices = prices.map((price) => Math.log(price));
  const sigmaX = logOfPrices.reduce((acc, _, i) => {
    return acc + i;
  }, 0);
  const sigmaY = logOfPrices.reduce((acc, price) => {
    return acc + price;
  }, 0);
  const sigmaXiYi = logOfPrices.reduce((acc, price, i) => {
    return acc + i * price;
  }, 0);
  const sigmaXsq = logOfPrices.reduce((acc, price, i) => {
    return acc + Math.pow(i, 2);
  }, 0);

  const n = logOfPrices.length;

  const slope =
    (n * sigmaXiYi - sigmaX * sigmaY) / (n * sigmaXsq - Math.pow(sigmaX, 2));
  const meanY = sigmaY / n;
  const SS_tot = logOfPrices.reduce((acc, price) => {
    return acc + Math.pow(price - meanY, 2);
  }, 0);

  const b = (sigmaY - slope * sigmaX) / n;

  const SS_res = logOfPrices.reduce((acc, price, i) => {
    return acc + Math.pow(price - (slope * i + b), 2);
  }, 0);

  const r2 = 1 - SS_res / SS_tot;
  console.log("🚀 ~ linearRegression ~ r2:", r2);

  return { slope: slope * 252, r2 };
}

// ─── Tests ───────────────────────────────────────────────────────────────────
function assertClose(
  actual: number,
  expected: number,
  tolerance: number,
  msg: string,
) {
  if (Math.abs(actual - expected) > tolerance) {
    console.error(`✗ FAILED: ${msg}`);
    console.error(`  Expected: ${expected} ± ${tolerance}`);
    console.error(`  Got:      ${actual}`);
    process.exit(1);
  }
  console.log(`✓ ${msg} (${actual.toFixed(4)})`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`✗ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

// Test 1: Perfect uptrend (constant daily growth)
// Price doubles every 252 days → annualized slope ≈ ln(2) * 252 / 252 ≈ 0.693
const perfectTrend = Array.from(
  { length: 90 },
  (_, i) => 100 * Math.exp(i * 0.003),
);
const r1 = linearRegression(perfectTrend);
assertClose(r1.slope, 0.003 * 252, 0.01, "perfect trend: slope ≈ 0.756");
assertClose(r1.r2, 1.0, 0.001, "perfect trend: R² ≈ 1.0");

// Test 2: Flat prices (no trend)
const flat = Array.from({ length: 90 }, () => 50);
const r2 = linearRegression(flat);
assertClose(r2.slope, 0, 0.01, "flat prices: slope ≈ 0");
// R² is undefined for flat data (0/0), but should not crash
assert(!isNaN(r2.r2), "flat prices: R² is not NaN");

// Test 3: Noisy uptrend (R² should be less than 1)
const noisyTrend = Array.from({ length: 90 }, (_, i) => {
  const base = 100 * Math.exp(i * 0.002);
  const noise = Math.sin(i * 0.5) * 5; // deterministic "noise"
  return base + noise;
});
const r3 = linearRegression(noisyTrend);
assert(
  r3.slope > 0.3,
  `noisy trend: slope should be positive (got ${r3.slope.toFixed(3)})`,
);
assert(
  r3.r2 > 0.5 && r3.r2 < 1.0,
  `noisy trend: R² between 0.5–1.0 (got ${r3.r2.toFixed(3)})`,
);

// Test 4: Downtrend
const downtrend = Array.from(
  { length: 90 },
  (_, i) => 200 * Math.exp(-i * 0.005),
);
const r4 = linearRegression(downtrend);
assert(
  r4.slope < -1.0,
  `downtrend: slope should be negative (got ${r4.slope.toFixed(3)})`,
);
assertClose(r4.r2, 1.0, 0.001, "perfect downtrend: R² ≈ 1.0");

// Test 5: Edge case — too few prices
const r5 = linearRegression([100]);
assert(r5.slope === 0 && r5.r2 === 0, "single price: returns zeros");

const r6 = linearRegression([]);
assert(r6.slope === 0 && r6.r2 === 0, "empty array: returns zeros");

// Test 6: Two prices (minimum for a line)
const r7 = linearRegression([100, 110]);
assert(
  r7.slope > 0,
  `two prices rising: positive slope (got ${r7.slope.toFixed(3)})`,
);
assertClose(
  r7.r2,
  1.0,
  0.001,
  "two points: R² = 1.0 (line always fits 2 points perfectly)",
);

console.log("\n🎉 All tests passed!");
console.log("\n📝 Questions to reflect on:");
console.log("   1. Why do we use ln(price) instead of raw price?");
console.log("   2. What does a slope of 1.5 mean in practical terms?");
console.log("   3. Why does R² = 1 for two points? Is that useful?");
console.log(
  "      (Hint: this is why MIN_DATA_POINTS = 60 in the real system)",
);

export {};
