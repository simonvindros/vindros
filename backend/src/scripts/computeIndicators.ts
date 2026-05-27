/**
 * COMPUTE INDICATORS — Calculate and upsert technical indicators
 *
 * Reads from: StockPrice (never writes to it)
 * Writes to:  TechnicalIndicator (upsert — safe to re-run)
 *
 * Indicators computed:
 *   - slope_90d: 90-day log-linear regression slope (annualized ×252)
 *   - r2_90d:    R² of the 90-day regression (trend quality)
 *   - ema_50:    50-day exponential moving average
 *   - ema_200:   200-day exponential moving average
 *
 * Only computes for dates not already in the DB (incremental).
 */
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../lib/prisma";
import { chunkArray } from "../lib/chunks";

// ─── Configuration ───────────────────────────────────────────────────────────
const INDICATORS = ["slope_90d", "r2_90d", "ema_50", "ema_200"] as const;
const BATCH_SIZE = 500;
const REG_PERIOD = 90;
const EMA_SHORT = 50;
const EMA_LONG = 200;
// Need at least this many days of price history before we can compute
const WARMUP_DAYS = EMA_LONG; // 200 (longest indicator)

// ─── Math (self-contained — does NOT import from backtest/) ──────────────────
function linearRegression(prices: number[]): { slope: number; r2: number } {
  if (prices.length < 60) return { slope: 0, r2: 0 };

  const yAxis = prices.map((p) => Math.log(p));
  const xAxis = prices.map((_, i) => i);
  const n = prices.length;
  const sumX = xAxis.reduce((s, x) => s + x, 0);
  const sumY = yAxis.reduce((s, y) => s + y, 0);
  const sumXY = xAxis.reduce((s, x, i) => s + x * yAxis[i], 0);
  const sumX2 = xAxis.reduce((s, x) => s + x * x, 0);
  const sumY2 = yAxis.reduce((s, y) => s + y * y, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const r2 = Math.pow(n * sumXY - sumX * sumY, 2) /
    ((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return { slope, r2: isNaN(r2) ? 0 : r2 };
}

function computeEma(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = new Array(prices.length).fill(NaN);

  // Seed: SMA of first `period` prices
  if (prices.length < period) return result;
  let ema = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
  result[period - 1] = ema;

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────
export const computeIndicators = async () => {
  console.log("Computing technical indicators...\n");

  const instruments = await prisma.instrument.findMany({
    where: { countryId: 1 },
    select: { id: true, name: true },
  });

  console.log(`  ${instruments.length} instruments to process`);

  // Find the latest computed date per instrument (to skip already-done work)
  const latestComputed = await prisma.$queryRaw<Array<{ instrumentId: number; maxDate: Date }>>`
    SELECT "instrumentId", MAX(date) as "maxDate"
    FROM "TechnicalIndicator"
    WHERE type = 'slope_90d'
    GROUP BY "instrumentId"
  `;
  const latestMap = new Map(latestComputed.map((r) => [r.instrumentId, r.maxDate]));

  let totalInserted = 0;
  let skipped = 0;

  for (const instrument of instruments) {
    // Load all prices for this instrument
    const prices = await prisma.stockPrice.findMany({
      where: { instrumentId: instrument.id },
      select: { date: true, close: true },
      orderBy: { date: "asc" },
    });

    if (prices.length < WARMUP_DAYS) {
      skipped++;
      continue;
    }

    const closes = prices.map((p) => Number(p.close));
    const dates = prices.map((p) => p.date);

    // Determine start index: skip already computed dates
    const lastComputed = latestMap.get(instrument.id);
    let startIdx = WARMUP_DAYS;
    if (lastComputed) {
      const lastStr = lastComputed.toISOString().slice(0, 10);
      const idx = dates.findIndex((d) => d.toISOString().slice(0, 10) > lastStr);
      if (idx === -1) {
        skipped++;
        continue; // all dates already computed
      }
      startIdx = Math.max(idx, WARMUP_DAYS);
    }

    // Compute EMAs for entire series (efficient — one pass each)
    const ema50 = computeEma(closes, EMA_SHORT);
    const ema200 = computeEma(closes, EMA_LONG);

    // Build records for new dates only
    const records: Array<{ instrumentId: number; date: Date; type: string; value: number }> = [];

    for (let i = startIdx; i < closes.length; i++) {
      const date = dates[i];

      // Slope + R²
      if (i >= REG_PERIOD) {
        const slice = closes.slice(i - REG_PERIOD + 1, i + 1);
        const reg = linearRegression(slice);
        if (isFinite(reg.slope) && !isNaN(reg.slope)) {
          records.push({ instrumentId: instrument.id, date, type: "slope_90d", value: reg.slope * 252 });
        }
        if (isFinite(reg.r2) && !isNaN(reg.r2)) {
          records.push({ instrumentId: instrument.id, date, type: "r2_90d", value: reg.r2 });
        }
      }

      // EMA 50
      if (isFinite(ema50[i]) && !isNaN(ema50[i])) {
        records.push({ instrumentId: instrument.id, date, type: "ema_50", value: ema50[i] });
      }

      // EMA 200
      if (isFinite(ema200[i]) && !isNaN(ema200[i])) {
        records.push({ instrumentId: instrument.id, date, type: "ema_200", value: ema200[i] });
      }
    }

    // Batch upsert
    if (records.length > 0) {
      for (const batch of chunkArray(records, BATCH_SIZE)) {
        await prisma.technicalIndicator.createMany({
          data: batch,
          skipDuplicates: true,
        });
      }
      totalInserted += records.length;
    }
  }

  console.log(`\n  ✓ Computed ${totalInserted} indicator values`);
  console.log(`  ✓ Skipped ${skipped} instruments (already up-to-date or insufficient data)`);
};

// Run directly
if (require.main === module) {
  computeIndicators()
    .catch((err) => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
