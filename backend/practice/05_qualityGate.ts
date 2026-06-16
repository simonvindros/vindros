/**
 * EXERCISE 5: Quality Gate (Fundamental Filter for Small Caps)
 *
 * Problem:
 * Given KPI data for a set of small-cap stocks, determine which ones
 * pass the quality gate and are eligible for momentum ranking.
 *
 * The quality gate asks: "Is this a real, growing, profitable business?"
 *
 * Annual Baseline (all must pass):
 *   - Average revenue growth (last 5 years) > MIN_REVENUE_GROWTH (10%)
 *   - At most 1 negative growth year in the last 4
 *   - No extreme years (> +200% or < -30%) in last 5
 *   - Latest revenue > MIN_REVENUE_MSEK (50 MSEK)
 *   - Latest operating margin > MIN_OPERATING_MARGIN (5%)
 *   - Operating margin improving (latest > 4 years ago)
 *   - At least MIN_YEARS_DATA (3) years of data
 *
 * Quarterly Freshness Check (disqualifies if failing):
 *   - Latest quarter revenue growth < -10% → disqualified
 *   - Latest quarter operating margin < 0% → disqualified
 *
 * Think about:
 *   - Why require BOTH growth AND profitability?
 *   - Why the "no extreme years" rule? (Hint: acquisitions, one-off events)
 *   - Why quarterly check? (Hint: annual data can be 11 months stale)
 */

// ─── Configuration ───────────────────────────────────────────────────────────
const MIN_REVENUE_GROWTH = 10;
const MIN_REVENUE_MSEK = 50;
const MIN_OPERATING_MARGIN = 5;
const MIN_YEARS_DATA = 3;

// ─── Types ───────────────────────────────────────────────────────────────────
type AnnualData = {
  year: number;
  revenueGrowth: number | null; // percentage, e.g. 25 = 25%
  revenue: number | null;       // in MSEK
  operatingMargin: number | null; // percentage, e.g. 8 = 8%
};

type QuarterlyData = {
  year: number;
  quarter: number; // 1-4
  revenueGrowth: number | null;
  operatingMargin: number | null;
};

type StockKpiData = {
  id: number;
  name: string;
  annualData: AnnualData[];     // sorted by year ascending
  quarterlyData: QuarterlyData[]; // sorted by year+quarter ascending
};

// ─── Implement this ──────────────────────────────────────────────────────────
function qualityGate(stocks: StockKpiData[], asOfYear: number): number[] {
  /**
   * Returns an array of stock IDs that pass both:
   *   1. Annual baseline check (using data up to and including asOfYear)
   *   2. Quarterly freshness check (using latest available quarter)
   *
   * Steps for each stock:
   *   a) Filter annual data to years <= asOfYear
   *   b) Check MIN_YEARS_DATA
   *   c) Check 5-year average revenue growth
   *   d) Check negative year count (last 4 years)
   *   e) Check extreme years (last 5 years)
   *   f) Check latest revenue
   *   g) Check latest operating margin
   *   h) Check margin improvement (latest vs 4 years ago)
   *   i) If annual passes → check quarterly freshness
   */

  // YOUR CODE HERE
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

const AS_OF_YEAR = 2024;

const stocks: StockKpiData[] = [
  {
    // Should PASS — good growth, profitable, improving
    id: 1,
    name: "HealthyGrowth",
    annualData: [
      { year: 2020, revenueGrowth: 15, revenue: 40, operatingMargin: 4 },
      { year: 2021, revenueGrowth: 20, revenue: 55, operatingMargin: 6 },
      { year: 2022, revenueGrowth: 18, revenue: 70, operatingMargin: 7 },
      { year: 2023, revenueGrowth: 25, revenue: 90, operatingMargin: 9 },
      { year: 2024, revenueGrowth: 12, revenue: 105, operatingMargin: 10 },
    ],
    quarterlyData: [
      { year: 2024, quarter: 3, revenueGrowth: 8, operatingMargin: 9 },
      { year: 2024, quarter: 4, revenueGrowth: 5, operatingMargin: 8 },
    ],
  },
  {
    // Should FAIL — revenue too low
    id: 2,
    name: "TinyRevenue",
    annualData: [
      { year: 2020, revenueGrowth: 30, revenue: 10, operatingMargin: 8 },
      { year: 2021, revenueGrowth: 25, revenue: 15, operatingMargin: 9 },
      { year: 2022, revenueGrowth: 20, revenue: 20, operatingMargin: 10 },
      { year: 2023, revenueGrowth: 35, revenue: 30, operatingMargin: 12 },
      { year: 2024, revenueGrowth: 40, revenue: 45, operatingMargin: 14 },
    ],
    quarterlyData: [
      { year: 2024, quarter: 4, revenueGrowth: 20, operatingMargin: 12 },
    ],
  },
  {
    // Should FAIL — operating margin declining (latest < 4 years ago)
    id: 3,
    name: "DecliningMargins",
    annualData: [
      { year: 2020, revenueGrowth: 12, revenue: 80, operatingMargin: 15 },
      { year: 2021, revenueGrowth: 15, revenue: 95, operatingMargin: 12 },
      { year: 2022, revenueGrowth: 10, revenue: 110, operatingMargin: 9 },
      { year: 2023, revenueGrowth: 14, revenue: 130, operatingMargin: 7 },
      { year: 2024, revenueGrowth: 11, revenue: 150, operatingMargin: 6 },
    ],
    quarterlyData: [
      { year: 2024, quarter: 4, revenueGrowth: 8, operatingMargin: 6 },
    ],
  },
  {
    // Should FAIL — too many negative growth years
    id: 4,
    name: "InconsistentGrowth",
    annualData: [
      { year: 2020, revenueGrowth: 30, revenue: 60, operatingMargin: 6 },
      { year: 2021, revenueGrowth: -5, revenue: 58, operatingMargin: 7 },
      { year: 2022, revenueGrowth: -8, revenue: 55, operatingMargin: 8 },
      { year: 2023, revenueGrowth: 40, revenue: 80, operatingMargin: 9 },
      { year: 2024, revenueGrowth: 15, revenue: 95, operatingMargin: 10 },
    ],
    quarterlyData: [
      { year: 2024, quarter: 4, revenueGrowth: 12, operatingMargin: 9 },
    ],
  },
  {
    // Should FAIL annual pass but FAIL quarterly (revenue growth < -10%)
    id: 5,
    name: "RecentDecline",
    annualData: [
      { year: 2020, revenueGrowth: 20, revenue: 60, operatingMargin: 6 },
      { year: 2021, revenueGrowth: 18, revenue: 75, operatingMargin: 8 },
      { year: 2022, revenueGrowth: 22, revenue: 95, operatingMargin: 9 },
      { year: 2023, revenueGrowth: 15, revenue: 115, operatingMargin: 11 },
      { year: 2024, revenueGrowth: 12, revenue: 130, operatingMargin: 12 },
    ],
    quarterlyData: [
      { year: 2024, quarter: 3, revenueGrowth: 5, operatingMargin: 10 },
      { year: 2024, quarter: 4, revenueGrowth: -15, operatingMargin: 8 },
    ],
  },
  {
    // Should FAIL — not enough data (< 3 years)
    id: 6,
    name: "NewCompany",
    annualData: [
      { year: 2023, revenueGrowth: 50, revenue: 80, operatingMargin: 12 },
      { year: 2024, revenueGrowth: 40, revenue: 120, operatingMargin: 15 },
    ],
    quarterlyData: [
      { year: 2024, quarter: 4, revenueGrowth: 30, operatingMargin: 14 },
    ],
  },
  {
    // Should FAIL — extreme growth spike (> 200% in one year)
    id: 7,
    name: "AcquisitionSpike",
    annualData: [
      { year: 2020, revenueGrowth: 10, revenue: 30, operatingMargin: 5 },
      { year: 2021, revenueGrowth: 250, revenue: 100, operatingMargin: 6 },
      { year: 2022, revenueGrowth: 12, revenue: 115, operatingMargin: 7 },
      { year: 2023, revenueGrowth: 15, revenue: 135, operatingMargin: 8 },
      { year: 2024, revenueGrowth: 10, revenue: 150, operatingMargin: 9 },
    ],
    quarterlyData: [
      { year: 2024, quarter: 4, revenueGrowth: 8, operatingMargin: 9 },
    ],
  },
  {
    // Should PASS — barely meets all thresholds
    id: 8,
    name: "JustBarely",
    annualData: [
      { year: 2020, revenueGrowth: 8, revenue: 40, operatingMargin: 4 },
      { year: 2021, revenueGrowth: 11, revenue: 45, operatingMargin: 5 },
      { year: 2022, revenueGrowth: -2, revenue: 48, operatingMargin: 5.5 },
      { year: 2023, revenueGrowth: 12, revenue: 52, operatingMargin: 6 },
      { year: 2024, revenueGrowth: 14, revenue: 60, operatingMargin: 7 },
    ],
    quarterlyData: [
      { year: 2024, quarter: 4, revenueGrowth: 2, operatingMargin: 5.5 },
    ],
  },
];

const qualified = qualityGate(stocks, AS_OF_YEAR);

assert(qualified.includes(1), "HealthyGrowth passes (strong fundamentals)");
assert(!qualified.includes(2), "TinyRevenue fails (revenue < 50 MSEK)");
assert(!qualified.includes(3), "DecliningMargins fails (margin worse than 4yr ago)");
assert(!qualified.includes(4), "InconsistentGrowth fails (2 negative years in last 4)");
assert(!qualified.includes(5), "RecentDecline fails (quarterly revenue growth < -10%)");
assert(!qualified.includes(6), "NewCompany fails (< 3 years data)");
assert(!qualified.includes(7), "AcquisitionSpike fails (year > 200%)");
assert(qualified.includes(8), "JustBarely passes (meets all minimums)");

console.log(`\nQualified: ${qualified.length} / ${stocks.length} stocks`);
console.log("\n🎉 All tests passed!");
console.log("\n📝 Questions:");
console.log("   1. Why check 'margin improving' instead of just 'margin > 5%'?");
console.log("   2. A stock has 15% avg growth but one year at -35%. Should it pass?");
console.log("   3. Why is the quarterly check MORE lenient (-10%) than annual (must be positive avg)?");

export {};
