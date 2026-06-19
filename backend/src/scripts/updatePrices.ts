import dotenv from "dotenv";
dotenv.config();

import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { chunkArray } from "../lib/chunks";

const DRIFT_THRESHOLD = 0.005; // 0.5% — price mismatch threshold for split detection

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
 * Phase 0: Proactively detect and fix split-adjusted prices.
 *
 * 1. Fetch all splits from Börsdata StockSplits API
 * 2. Upsert into StockSplit table (new ones get applied: false)
 * 3. For each unapplied split: compare our stored price at split date vs Börsdata's
 * 4. If they differ → our data is stale → delete + re-fetch full history
 * 5. Mark applied: true
 */
const applySplits = async () => {
  console.log("  Checking for unapplied stock splits...");

  // Step 1: Fetch all splits from Börsdata
  let apiSplits: {
    instrumentId: number;
    splitType: string;
    ratio: string;
    splitDate: string;
  }[] = [];

  try {
    const { data } = await api.get("/instruments/StockSplits");
    apiSplits = data.stockSplitList ?? [];
    console.log(`  Fetched ${apiSplits.length} splits from Börsdata API`);
  } catch (error: any) {
    console.error(`  ✗ Failed to fetch splits: ${error.message}`);
    return;
  }

  // Step 2: Upsert — new splits get applied: false
  let newSplits = 0;
  for (const split of apiSplits) {
    if (!knownInstrumentIds.has(split.instrumentId)) continue;

    const ratioFactor = parseRatioFactor(split.splitType, split.ratio);
    const splitDate = new Date(split.splitDate);

    const existing = await prisma.stockSplit.findUnique({
      where: {
        instrumentId_splitDate: {
          instrumentId: split.instrumentId,
          splitDate,
        },
      },
    });

    if (!existing) {
      await prisma.stockSplit.create({
        data: {
          instrumentId: split.instrumentId,
          splitType: split.splitType,
          ratio: split.ratio,
          splitDate,
          ratioFactor,
          applied: false,
        },
      });
      newSplits++;
    }
  }

  if (newSplits > 0) {
    console.log(`  ${newSplits} new split(s) recorded`);
  }

  // Step 3: Find all unapplied splits
  const unapplied = await prisma.stockSplit.findMany({
    where: { applied: false },
  });

  if (unapplied.length === 0) {
    console.log("  ✓ All splits already applied");
    return;
  }

  console.log(`  ${unapplied.length} unapplied split(s) — checking prices...`);

  // Step 4: For each unapplied split, compare stored vs API price at split date
  // Group by instrumentId to avoid re-fetching the same instrument multiple times
  const instrumentsToRefetch = new Set<number>();
  const splitsByInstrument = new Map<number, typeof unapplied>();

  for (const split of unapplied) {
    if (!splitsByInstrument.has(split.instrumentId)) {
      splitsByInstrument.set(split.instrumentId, []);
    }
    splitsByInstrument.get(split.instrumentId)!.push(split);
  }

  for (const [instrumentId, splits] of splitsByInstrument) {
    const earliestSplit = splits.sort(
      (a, b) => a.splitDate.getTime() - b.splitDate.getTime(),
    )[0];
    const splitDateStr = earliestSplit.splitDate.toISOString().slice(0, 10);

    // Check the OLDEST stored price — most likely to be unadjusted
    const storedPrice = await prisma.stockPrice.findFirst({
      where: { instrumentId },
      orderBy: { date: "asc" },
      select: { date: true, close: true },
    });

    if (!storedPrice) {
      // No stored prices at all — mark as applied, nothing to fix
      for (const s of splits) {
        await prisma.stockSplit.update({
          where: { id: s.id },
          data: { applied: true },
        });
      }
      continue;
    }

    const checkDateStr = storedPrice.date.toISOString().slice(0, 10);

    try {
      const { data } = await api.get("/instruments/stockprices", {
        params: {
          instList: String(instrumentId),
          from: checkDateStr,
          to: checkDateStr,
        },
      });

      const instData = data.stockPricesArrayList?.[0];
      const apiPrice = instData?.stockPricesList?.find(
        (p: any) => p.d.slice(0, 10) === checkDateStr,
      );

      if (!apiPrice) {
        // Can't verify (no API data for that date) — re-fetch to be safe
        console.log(
          `    ? instrument ${instrumentId} — no API data for ${checkDateStr}, will re-fetch`,
        );
        instrumentsToRefetch.add(instrumentId);
        continue;
      }

      const storedClose = Number(storedPrice.close);
      const apiClose = apiPrice.c;
      const drift = Math.abs(apiClose - storedClose) / storedClose;

      if (drift > DRIFT_THRESHOLD) {
        console.log(
          `    ⚠ Stale prices: instrument ${instrumentId} — ` +
            `stored ${storedClose.toFixed(2)}, API ${apiClose} on ${checkDateStr} ` +
            `(split: ${earliestSplit.splitType} ${earliestSplit.ratio} on ${splitDateStr})`,
        );
        instrumentsToRefetch.add(instrumentId);
      } else {
        // Prices already match — mark all splits for this instrument as applied
        for (const s of splits) {
          await prisma.stockSplit.update({
            where: { id: s.id },
            data: { applied: true },
          });
        }
      }
    } catch (error: any) {
      console.error(
        `    ✗ Price check failed for instrument ${instrumentId}: ${error.message}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (instrumentsToRefetch.size === 0) {
    console.log("  ✓ All split-affected prices are up to date");
    return;
  }

  // Step 5: Re-fetch full history for stale instruments
  console.log(
    `\n  Re-fetching ${instrumentsToRefetch.size} instrument(s) with stale split data...`,
  );

  const refetchChunks = chunkArray([...instrumentsToRefetch], 10);

  for (let i = 0; i < refetchChunks.length; i++) {
    const chunk = refetchChunks[i];
    console.log(
      `    Batch ${i + 1}/${refetchChunks.length}: instruments ${chunk.join(", ")}`,
    );

    try {
      const { data } = await api.get("/instruments/stockprices", {
        params: { instList: chunk.join(",") },
      });

      for (const instData of data.stockPricesArrayList) {
        await prisma.stockPrice.deleteMany({
          where: { instrumentId: instData.instrument },
        });

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

        // Mark all splits for this instrument as applied
        await prisma.stockSplit.updateMany({
          where: { instrumentId: instData.instrument },
          data: { applied: true },
        });
      }
    } catch (error: any) {
      console.error(`    ✗ Re-fetch failed: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(
    `  ✓ Re-fetched ${instrumentsToRefetch.size} instrument(s) with corrected split data`,
  );
};

const main = async () => {
  try {
    console.log("Updating stock prices...\n");

    // Load known instruments to filter out unknown IDs from API responses
    await loadKnownInstruments();

    // Phase 0: proactively fix split-adjusted prices
    await applySplits();

    // Phase 1: backfill any gap up to yesterday
    await backfillGap();

    // Phase 2: fetch today's latest
    await fetchLatest();

    console.log("\n✓ Done!");
  } catch (error) {
    console.error("Update failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

main();
