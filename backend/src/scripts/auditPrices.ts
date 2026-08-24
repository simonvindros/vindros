import "dotenv/config";
import { prisma } from "../lib/prisma";
import { api } from "../lib/api";

/**
 * Price data integrity audit.
 *
 * 1. Find all instruments with suspicious day-to-day moves (>3x or <0.33x) and no split record.
 * 2. For each, query the Börsdata API to get the actual price start date.
 * 3. If our DB has prices before the API's start → stale data from a previous company/listing.
 *
 * READ-ONLY — nothing is deleted.
 */

const MARKETS = [3, 4, 5];
const JUMP_THRESHOLD = 3;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("═══ PRICE DATA INTEGRITY AUDIT ═══\n");

  const insts = await prisma.instrument.findMany({
    where: { marketId: { in: MARKETS } },
    select: { id: true, ticker: true, name: true },
  });

  type Suspect = {
    id: number; ticker: string; name: string;
    jumpDate: string; from: number; to: number; ratio: number;
    dbStart: string; dbTotal: number;
  };
  const suspects: Suspect[] = [];

  console.log("Step 1: Scanning " + insts.length + " instruments for suspicious jumps...");

  for (const inst of insts) {
    const prices = await prisma.stockPrice.findMany({
      where: { instrumentId: inst.id },
      select: { date: true, close: true },
      orderBy: { date: "asc" },
    });

    for (let i = 1; i < prices.length; i++) {
      const prev = Number(prices[i - 1].close);
      const curr = Number(prices[i].close);
      if (prev > 0.01) {
        const ratio = curr / prev;
        if (ratio > JUMP_THRESHOLD || ratio < 1 / JUMP_THRESHOLD) {
          // Check for split record
          const split = await (prisma as any).stockSplit.findFirst({
            where: {
              instrumentId: inst.id,
              splitDate: {
                gte: new Date(prices[i].date.getTime() - 14 * 86400000),
                lte: new Date(prices[i].date.getTime() + 14 * 86400000),
              },
            },
          });
          if (!split) {
            suspects.push({
              id: inst.id, ticker: inst.ticker, name: inst.name,
              jumpDate: prices[i].date.toISOString().slice(0, 10),
              from: prev, to: curr, ratio,
              dbStart: prices[0].date.toISOString().slice(0, 10),
              dbTotal: prices.length,
            });
          }
          break;
        }
      }
    }
  }

  console.log("  Found " + suspects.length + " suspects (no split record).\n");

  // Step 2: Query API for each suspect
  console.log("Step 2: Querying API for actual price start dates (" + suspects.length + " calls, ~1/sec)...\n");

  console.log(
    "  " + "Ticker".padEnd(12) + "JumpDate".padEnd(12) +
    "DB-Start".padEnd(12) + "API-Start".padEnd(12) +
    "Stale".padStart(6) + "  " +
    "Jump".padStart(12) + "  Verdict"
  );
  console.log("  " + "─".repeat(90));

  const idReuse: (Suspect & { apiStart: string; staleRows: number })[] = [];
  const realMoves: (Suspect & { apiStart: string })[] = [];
  const noApiData: Suspect[] = [];

  for (let i = 0; i < suspects.length; i++) {
    const s = suspects[i];
    let apiStart = "?";
    let staleRows = 0;

    try {
      const res = await api.get(`/instruments/${s.id}/stockprices`);
      const apiPrices = res.data.stockPricesList || [];

      if (apiPrices.length > 0) {
        apiStart = apiPrices[0].d;
        const apiStartDate = new Date(apiStart);
        staleRows = await prisma.stockPrice.count({
          where: { instrumentId: s.id, date: { lt: apiStartDate } },
        });

        if (staleRows > 5) {
          idReuse.push({ ...s, apiStart, staleRows });
        } else {
          realMoves.push({ ...s, apiStart });
        }
      } else {
        noApiData.push(s);
        apiStart = "NO DATA";
      }
    } catch (err: any) {
      apiStart = "ERR:" + (err.response?.status || "?");
      noApiData.push(s);
    }

    const jumpStr = s.ratio > 1 ? "x" + s.ratio.toFixed(1) + " UP" : "x" + s.ratio.toFixed(2) + " DN";
    const verdict = staleRows > 5
      ? "ID REUSE (" + staleRows + " stale rows)"
      : staleRows > 0
        ? "Minor (" + staleRows + " rows)"
        : apiStart.startsWith("ERR") || apiStart === "NO DATA"
          ? apiStart
          : "OK";

    console.log(
      "  " + s.ticker.padEnd(12) + s.jumpDate.padEnd(12) +
      s.dbStart.padEnd(12) + apiStart.padEnd(12) +
      String(staleRows).padStart(6) + "  " +
      jumpStr.padStart(12) + "  " + verdict
    );

    if (i < suspects.length - 1) await sleep(1100);
  }

  // Summary
  console.log("\n" + "═".repeat(80));
  console.log("  SUMMARY");
  console.log("═".repeat(80));
  console.log("  Total suspects:                " + suspects.length);
  console.log("  Confirmed ID reuse:            " + idReuse.length);
  console.log("  Total stale rows to delete:    " + idReuse.reduce((s, r) => s + r.staleRows, 0));
  console.log("  Real/legitimate moves:         " + realMoves.length);
  console.log("  No API data / errors:          " + noApiData.length);

  if (idReuse.length > 0) {
    console.log("\n  ID REUSE INSTRUMENTS (safe to delete prices before API start):");
    for (const r of idReuse) {
      console.log("    " + r.ticker.padEnd(12) + " delete " + r.staleRows + " rows before " + r.apiStart);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
