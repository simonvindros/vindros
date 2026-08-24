/**
 * Incremental KPI update — only fetches what's missing.
 *
 * Strategy:
 *   1. Query DB for every instrument×kpi combo that already exists
 *   2. Skip combos where maxYear >= current year (already up-to-date)
 *   3. Fetch only stale combos from API (maxCount=5 → last 5 data points)
 *   4. Insert new rows (skipDuplicates)
 *
 * This avoids ~600k wasted API calls for instrument×kpi combos that
 * don't exist in Börsdata. Only combos previously seeded get updated.
 *
 * For initial seeding or backfilling, use:  npm run seed / npm run reseed:kpis
 *
 * Usage:
 *   npm run update:kpis                  (incremental — skip up-to-date)
 *   npm run update:kpis -- --full        (re-fetch all existing combos)
 */
import dotenv from "dotenv";
dotenv.config();

import { api } from "../lib/api";
import { prisma } from "../lib/prisma";

const DELAY_MS = 110; // ~9 calls/sec, safely under Börsdata's 10/sec limit
const CURRENT_YEAR = new Date().getFullYear();

async function main() {
  const fullMode = process.argv.includes("--full");

  const instruments = await prisma.instrument.findMany({
    select: { id: true, name: true },
    where: { countryId: 1 }, // Sweden only
  });

  console.log(`Updating KPIs for ${instruments.length} Swedish instruments`);
  console.log(`Mode: ${fullMode ? "FULL (re-fetch all)" : "INCREMENTAL (skip up-to-date)"}`);
  console.log("");

  // ─── Find what we already have ─────────────────────────────────────────
  // Key: "instId_kpiId_reportType_priceType" → latest year
  // We ONLY update combos that already exist in our DB — if an instrument
  // doesn't have a KPI, the API will return nothing anyway.
  const latestByKey = new Map<string, number>();

  const existing: { instrumentId: number; kpiId: number; reportType: string; priceType: string; maxYear: number }[] =
    await prisma.$queryRaw`
      SELECT "instrumentId", "kpiId", "reportType", "priceType", MAX("year") as "maxYear"
      FROM "KpiValue"
      WHERE "instrumentId" = ANY(${instruments.map(i => i.id)})
      GROUP BY "instrumentId", "kpiId", "reportType", "priceType"
    `;

  for (const row of existing) {
    latestByKey.set(
      `${row.instrumentId}_${row.kpiId}_${row.reportType}_${row.priceType}`,
      Number(row.maxYear),
    );
  }
  console.log(`  Found ${latestByKey.size} existing instrument×kpi combos in DB`);

  // Build a set of combos to actually fetch (exist in DB and need updating)
  type FetchTarget = { instrumentId: number; kpiId: number; reportType: string; priceType: string };
  const toFetch: FetchTarget[] = [];

  for (const [key, maxYear] of latestByKey) {
    if (!fullMode && maxYear >= CURRENT_YEAR) continue;
    const [instId, kpiId, reportType, priceType] = key.split("_");
    toFetch.push({
      instrumentId: Number(instId),
      kpiId: Number(kpiId),
      reportType,
      priceType,
    });
  }

  console.log(`  Need to update: ${toFetch.length} combos (${fullMode ? "full mode" : `${latestByKey.size - toFetch.length} already current`})`);
  if (toFetch.length > 0) {
    const eta = Math.ceil((toFetch.length * DELAY_MS) / 60000);
    console.log(`  ETA: ~${eta} minutes`);
  }

  // ─── Fetch and insert ─────────────────────────────────────────────────
  let totalNew = 0;
  let apiCalls = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const t = toFetch[i];

    try {
      const response = await api.get(
        `/instruments/${t.instrumentId}/kpis/${t.kpiId}/${t.reportType}/${t.priceType}/history`,
        { params: { maxCount: 5 } },
      );
      apiCalls++;

      const values = response.data.values;
      if (values && values.length > 0) {
        const records = values
          .filter((v: any) => v.v !== null && v.v !== undefined)
          .map((v: any) => ({
            instrumentId: t.instrumentId,
            kpiId: t.kpiId,
            reportType: t.reportType,
            priceType: t.priceType,
            year: v.y,
            period: v.p ?? 0,
            value: v.v,
          }));

        const result = await prisma.kpiValue.createMany({
          data: records,
          skipDuplicates: true,
        });

        totalNew += result.count;
      }
    } catch {
      // Instrument may not have this KPI — skip silently
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));

    if (apiCalls % 500 === 0 && apiCalls > 0) {
      const pct = ((i / toFetch.length) * 100).toFixed(1);
      console.log(`  [${pct}%] ${apiCalls} API calls, +${totalNew} new rows`);
    }
  }

  console.log("");
  console.log(`✓ Done — ${totalNew} new KPI records, ${apiCalls} API calls`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
