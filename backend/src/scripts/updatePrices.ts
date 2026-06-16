import dotenv from "dotenv";
dotenv.config();

import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { chunkArray } from "../lib/chunks";

const DRIFT_THRESHOLD = 0.005; // 0.5% — triggers full re-fetch
const NORDIC_COUNTRY_IDS = [1, 2, 3, 4]; // Sverige, Norge, Finland, Danmark

const getWeekdays = (start: Date, end: Date): string[] => {
  const dates: string[] = [];
  const current = new Date(start);
  current.setDate(current.getDate() + 1); // start from day after latest

  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(current.toISOString().slice(0, 10));
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
};

const BATCH_SIZE = 30; // Process 30 days at a time, then release memory

let knownInstrumentIds: Set<number>;

const loadKnownInstruments = async () => {
  const instruments = await prisma.instrument.findMany({
    select: { id: true },
  });
  knownInstrumentIds = new Set(instruments.map((i) => i.id));
  console.log(`  Loaded ${knownInstrumentIds.size} known instruments\n`);
};

const backfillGap = async () => {
  // Find the latest date among ACTIVE instruments (those with data in last 30 days),
  // ignoring long-dead stocks that would trigger a multi-year backfill
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

  const result = await prisma.$queryRaw<[{ min_date: Date | null }]>`
    SELECT MIN(latest)::date as min_date FROM (
      SELECT "instrumentId", MAX(date) as latest
      FROM "StockPrice"
      GROUP BY "instrumentId"
      HAVING MAX(date) > ${cutoff}::date
    ) sub
  `;

  const latestDate = result[0]?.min_date;

  if (!latestDate) {
    console.log("  No existing prices — skipping backfill");
    return;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const allDates = getWeekdays(latestDate, yesterday);

  if (allDates.length === 0) {
    console.log("  Prices are up to date — no gap to fill");
    return;
  }

  console.log(
    `  Backfilling ${allDates.length} days: ${allDates[0]} → ${allDates[allDates.length - 1]}`,
  );
  let totalInserted = 0;

  // Process in batches to avoid OOM
  for (
    let batchStart = 0;
    batchStart < allDates.length;
    batchStart += BATCH_SIZE
  ) {
    const batch = allDates.slice(batchStart, batchStart + BATCH_SIZE);
    console.log(
      `\n  Batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(allDates.length / BATCH_SIZE)} (${batch[0]} → ${batch[batch.length - 1]})`,
    );

    for (const date of batch) {
      try {
        const response = await api.get("/instruments/stockprices/date", {
          params: { date },
        });

        const prices = response.data.stockPricesList;

        if (!prices || prices.length === 0) {
          console.log(`    ${date} — no data (holiday)`);
          continue;
        }

        const records = prices
          .filter((price: any) => knownInstrumentIds.has(price.i))
          .map((price: any) => ({
            instrumentId: price.i,
            date: new Date(price.d),
            open: price.o ?? 0,
            high: price.h ?? 0,
            low: price.l ?? 0,
            close: price.c ?? 0,
            volume: price.v != null ? BigInt(price.v) : BigInt(0),
          }));

        const inserted = await prisma.stockPrice.createMany({
          data: records,
          skipDuplicates: true,
        });

        totalInserted += inserted.count;
        console.log(
          `    ${date} ✓ ${inserted.count} inserted (${prices.length - records.length} skipped)`,
        );
      } catch (error: any) {
        console.error(`    ${date} ✗ ${error.message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Release Prisma's internal memory between batches
    await prisma.$disconnect();
    await prisma.$connect();
  }

  console.log(`\n  ✓ Backfilled ${totalInserted} records total`);
};

const fetchLatest = async () => {
  console.log("  Fetching latest prices...");
  const response = await api.get("/instruments/stockprices/last");
  const prices = response.data.stockPricesList;

  const records = prices
    .filter((price: any) => knownInstrumentIds.has(price.i))
    .map((price: any) => ({
      instrumentId: price.i,
      date: new Date(price.d),
      open: price.o ?? 0,
      high: price.h ?? 0,
      low: price.l ?? 0,
      close: price.c ?? 0,
      volume: price.v != null ? BigInt(price.v) : BigInt(0),
    }));

  const inserted = await prisma.stockPrice.createMany({
    data: records,
    skipDuplicates: true,
  });

  console.log(
    `  ✓ ${inserted.count} latest records inserted (${prices.length - records.length} skipped)`,
  );
};

/**
 * Confirm detected drift against Börsdata's StockSplits endpoint (Nordic only).
 * Stores confirmed splits in the StockSplit table for record-keeping.
 */
const confirmNordicSplits = async (driftedIds: number[]) => {
  // Find which drifted instruments are Nordic
  const nordicInstruments = await prisma.instrument.findMany({
    where: {
      id: { in: driftedIds },
      countryId: { in: NORDIC_COUNTRY_IDS },
    },
    select: { id: true, name: true },
  });

  if (nordicInstruments.length === 0) {
    console.log(
      `\n  No Nordic instruments among drifted — skipping split confirmation`,
    );
    return;
  }

  console.log(
    `\n  Checking StockSplits API for ${nordicInstruments.length} Nordic instrument(s)...`,
  );

  try {
    const { data } = await api.get("/instruments/StockSplits");
    const splits: {
      instrumentId: number;
      splitType: string;
      ratio: string;
      splitDate: string;
    }[] = data.stockSplitList ?? [];

    const nordicIds = new Set(nordicInstruments.map((i) => i.id));

    for (const split of splits) {
      if (!nordicIds.has(split.instrumentId)) continue;

      const inst = nordicInstruments.find((i) => i.id === split.instrumentId);
      const ratioFactor = parseRatioFactor(split.splitType, split.ratio);

      console.log(
        `    ✓ Split confirmed: ${inst?.name} (${split.instrumentId}) — ` +
          `${split.splitType} ${split.ratio} on ${split.splitDate.slice(0, 10)}` +
          ` (factor: ${ratioFactor})`,
      );

      // Upsert into StockSplit table
      await prisma.stockSplit.upsert({
        where: {
          instrumentId_splitDate: {
            instrumentId: split.instrumentId,
            splitDate: new Date(split.splitDate),
          },
        },
        update: {
          splitType: split.splitType,
          ratio: split.ratio,
          ratioFactor,
        },
        create: {
          instrumentId: split.instrumentId,
          splitType: split.splitType,
          ratio: split.ratio,
          splitDate: new Date(split.splitDate),
          ratioFactor,
          applied: true, // Börsdata already adjusted the prices
        },
      });

      nordicIds.delete(split.instrumentId);
    }

    // Log any Nordic drift that wasn't explained by a split
    for (const id of nordicIds) {
      const inst = nordicInstruments.find((i) => i.id === id);
      console.log(
        `    ? ${inst?.name} (${id}) — drift detected but no split found in API (data correction?)`,
      );
    }
  } catch (error: any) {
    console.error(`    ✗ StockSplits API call failed: ${error.message}`);
  }
};

/**
 * Parse ratio string (e.g. "3:1", "1:10") into a price multiplier factor.
 * S (split) 3:1 → each old share becomes 3, price divides by 3 → factor 0.333
 * RS (reverse split) 1:10 → 10 old shares become 1, price multiplies by 10 → factor 10
 */
const parseRatioFactor = (splitType: string, ratio: string): number => {
  const parts = ratio.split(":");
  if (parts.length !== 2) return 1;

  const left = parseFloat(parts[0]);
  const right = parseFloat(parts[1]);
  if (!left || !right) return 1;

  // For splits (S, F, D): you get more shares, price goes down
  // Factor = how much old prices should be divided by
  // For reverse splits (RS): you get fewer shares, price goes up
  if (splitType === "RS") {
    return right / left; // e.g. "1:10" → 10
  }
  return left / right; // e.g. "3:1" → 0.333
};

/**
 * Phase 3: Detect price drift (splits/adjustments) and re-fetch affected instruments.
 *
 * For each instrument, compare our last stored price with what Börsdata now returns
 * for that same date. If they differ by more than DRIFT_THRESHOLD, Börsdata has
 * retroactively adjusted (e.g. stock split) — so we delete our stale data and
 * re-fetch all history for that instrument.
 */
const detectAndFixDrift = async () => {
  console.log("\n  Checking for price drift (split adjustments)...");

  // Get the last stored price per instrument
  const lastPrices = await prisma.$queryRaw<
    { instrumentId: number; date: Date; close: number }[]
  >`
    SELECT DISTINCT ON ("instrumentId")
      "instrumentId", date, close::float as close
    FROM "StockPrice"
    ORDER BY "instrumentId", date DESC
  `;

  // Group by the overlap date so we can batch API calls efficiently
  const byDate = new Map<string, { instrumentId: number; close: number }[]>();
  for (const row of lastPrices) {
    const dateStr = row.date.toISOString().slice(0, 10);
    if (!byDate.has(dateStr)) byDate.set(dateStr, []);
    byDate
      .get(dateStr)!
      .push({ instrumentId: row.instrumentId, close: row.close });
  }

  const driftedIds: number[] = [];

  // For each date group, fetch from Börsdata and compare
  // Most instruments will share the same latest date, so this is efficient
  for (const [dateStr, instruments] of byDate) {
    const chunks = chunkArray(
      instruments.map((i) => i.instrumentId),
      10,
    );

    for (const chunk of chunks) {
      try {
        const { data } = await api.get("/instruments/stockprices", {
          params: { instList: chunk.join(","), from: dateStr, to: dateStr },
        });

        for (const instData of data.stockPricesArrayList) {
          const apiPrice = instData.stockPricesList.find(
            (p: any) => p.d.slice(0, 10) === dateStr,
          );
          if (!apiPrice) continue;

          const stored = instruments.find(
            (i) => i.instrumentId === instData.instrument,
          );
          if (!stored) continue;

          const drift = Math.abs(apiPrice.c - stored.close) / stored.close;
          if (drift > DRIFT_THRESHOLD) {
            console.log(
              `    ⚠ Drift detected: instrument ${instData.instrument} — ` +
                `stored ${stored.close.toFixed(2)}, API ${apiPrice.c} (${(drift * 100).toFixed(1)}%)`,
            );
            driftedIds.push(instData.instrument);
          }
        }
      } catch (error: any) {
        console.error(`    ✗ Drift check failed for chunk: ${error.message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (driftedIds.length === 0) {
    console.log("  ✓ No drift detected — all prices match Börsdata");
    return;
  }

  // Confirm splits for Nordic instruments via the StockSplits endpoint
  await confirmNordicSplits(driftedIds);

  console.log(`\n  Re-fetching ${driftedIds.length} instruments with drift...`);

  // Re-fetch full history for drifted instruments
  const driftChunks = chunkArray(driftedIds, 10);

  for (let i = 0; i < driftChunks.length; i++) {
    const chunk = driftChunks[i];
    console.log(
      `    Batch ${i + 1}/${driftChunks.length}: instruments ${chunk.join(", ")}`,
    );

    try {
      const { data } = await api.get("/instruments/stockprices", {
        params: { instList: chunk.join(",") },
      });

      for (const instData of data.stockPricesArrayList) {
        // Delete all existing prices for this instrument
        await prisma.stockPrice.deleteMany({
          where: { instrumentId: instData.instrument },
        });

        // Insert fresh data from Börsdata
        const records = instData.stockPricesList.map((price: any) => ({
          instrumentId: instData.instrument,
          date: new Date(price.d),
          open: price.o ?? 0,
          high: price.h ?? 0,
          low: price.l ?? 0,
          close: price.c ?? 0,
          volume: price.v != null ? BigInt(price.v) : BigInt(0),
        }));

        await prisma.stockPrice.createMany({ data: records });
        console.log(
          `      ✓ ${instData.instrument}: replaced with ${records.length} rows`,
        );
      }
    } catch (error: any) {
      console.error(`    ✗ Re-fetch failed: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`  ✓ Re-fetched ${driftedIds.length} instruments`);
};

const main = async () => {
  try {
    console.log("Updating stock prices...\n");

    // Load known instruments to filter out unknown IDs from API responses
    await loadKnownInstruments();

    // Phase 1: backfill any gap up to yesterday
    await backfillGap();

    // Phase 2: fetch today's latest
    await fetchLatest();

    // Phase 3: detect drift from Börsdata adjustments (splits etc.)
    await detectAndFixDrift();

    console.log("\n✓ Done!");
  } catch (error) {
    console.error("Update failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

main();
