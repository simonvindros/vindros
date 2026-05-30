import { prisma } from "../lib/prisma";
import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";
import { Pool } from "pg";

/**
 * Import colleague's historical price data (including delisted companies).
 *
 * Files needed in ~/Downloads/:
 *   - stocks.csv     → instrument mapping (csvId → börsdataId + metadata)
 *   - StockCorse.csv → 5.3M price rows (OHLCV)
 *
 * stocks.csv format (semicolon-separated, no header):
 *   col1=csvId, col2=börsdataId, col3=name, col4=slug, col5=isin,
 *   col6=ticker, col7=yahooTicker, col8=sectorId, col9=branchId,
 *   col10=countryId, col11=listingDate, col12=unknown, col13=description,
 *   col14-16=flags
 *
 * StockCorse.csv format (semicolon-separated, Swedish decimals, no header):
 *   col1=rowId, col2=date, col3=high, col4=low, col5=open, col6=close,
 *   col7=volume, col8=csvInstrumentId, col9=flag
 */

const STOCKS_CSV = path.join(process.env.HOME || "", "Downloads/stocks.csv");
const PRICES_CSV = path.join(
  process.env.HOME || "",
  "Downloads/StockCorse.csv",
);
const PROGRESS_FILE = path.resolve(__dirname, "../../import-progress.json");

const BATCH_SIZE = 5000;

// Parse Swedish decimal format: "26,6667" → 26.6667
function parseSwedishDecimal(s: string): string {
  return s.replace(",", ".");
}

function loadImportProgress(): number {
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    return data.linesProcessed || 0;
  } catch {
    return 0;
  }
}

function saveImportProgress(linesProcessed: number) {
  fs.writeFileSync(
    PROGRESS_FILE,
    JSON.stringify({ linesProcessed, updatedAt: new Date().toISOString() }),
  );
}

// Phase 1: Create missing instruments from stocks.csv
async function createMissingInstruments(
  mapping: Map<number, number>,
): Promise<void> {
  console.log("\n--- Phase 1: Creating missing instruments ---");

  const lines = fs.readFileSync(STOCKS_CSV, "utf-8").trim().split("\n");

  const existingInsts = await prisma.instrument.findMany({
    select: { id: true },
  });
  const existingIds = new Set(existingInsts.map((i) => i.id));

  const toCreate: Array<{
    id: number;
    name: string;
    ticker: string;
    isin: string | null;
    urlName: string | null;
    sectorId: number | null;
    branchId: number | null;
    countryId: number;
    listingDate: Date | null;
  }> = [];

  for (const line of lines) {
    const cols = line.split(";");
    const csvId = parseInt(cols[0]);
    const borsdataId = parseInt(cols[1]);
    mapping.set(csvId, borsdataId);

    if (existingIds.has(borsdataId)) continue;

    const isin = cols[4] && cols[4] !== "NULL" ? cols[4] : null;
    const sectorId = cols[7] ? parseInt(cols[7]) : null;
    const branchId = cols[8] ? parseInt(cols[8]) : null;
    const countryId = parseInt(cols[9]) || 1;
    const listingDate = cols[10] ? new Date(cols[10]) : null;

    toCreate.push({
      id: borsdataId,
      name: cols[2],
      ticker: cols[5],
      isin,
      urlName: cols[3] && cols[3] !== "NULL" ? cols[3] : null,
      sectorId: sectorId || null,
      branchId: branchId || null,
      countryId,
      listingDate:
        listingDate && !isNaN(listingDate.getTime()) ? listingDate : null,
    });
  }

  if (toCreate.length === 0) {
    console.log("All instruments already exist in DB.");
    return;
  }

  console.log(`Creating ${toCreate.length} missing instruments...`);
  await prisma.instrument.createMany({
    data: toCreate,
    skipDuplicates: true,
  });
  console.log(`Done. ${toCreate.length} instruments created.`);
}

// Phase 2: Stream and import prices using raw pg (avoids Prisma memory leak)
async function importPrices(mapping: Map<number, number>): Promise<void> {
  console.log("\n--- Phase 2: Importing prices from StockCorse.csv ---");

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5432/vindros_quant",
  });

  const startLine = loadImportProgress();
  if (startLine > 0) {
    console.log(`Resuming from line ${startLine}...`);
  }

  const fileStream = fs.createReadStream(PRICES_CSV);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  let batch: string[][] = [];
  let totalInserted = 0;
  let skippedNoMapping = 0;
  let skippedInvalid = 0;

  for await (const line of rl) {
    lineNum++;
    if (lineNum <= startLine) continue;

    const cols = line.split(";");
    if (cols.length < 9) continue;

    const csvInstrumentId = parseInt(cols[7]);
    const borsdataId = mapping.get(csvInstrumentId);

    if (!borsdataId) {
      skippedNoMapping++;
      continue;
    }

    const date = cols[1];
    const high = parseSwedishDecimal(cols[2]);
    const low = parseSwedishDecimal(cols[3]);
    const open = parseSwedishDecimal(cols[4]);
    const close = parseSwedishDecimal(cols[5]);
    const volume = cols[6] || "0";

    if (
      !date ||
      high === "NaN" ||
      low === "NaN" ||
      open === "NaN" ||
      close === "NaN"
    ) {
      skippedInvalid++;
      continue;
    }

    batch.push([String(borsdataId), date, open, high, low, close, volume]);

    if (batch.length >= BATCH_SIZE) {
      await insertBatch(pool, batch);
      totalInserted += batch.length;
      batch = [];
      saveImportProgress(lineNum);

      if (lineNum % 100000 === 0) {
        console.log(
          `  Processed ${lineNum.toLocaleString()} lines, ~${totalInserted.toLocaleString()} inserted...`,
        );
      }
    }
  }

  // Final batch
  if (batch.length > 0) {
    await insertBatch(pool, batch);
    totalInserted += batch.length;
    saveImportProgress(lineNum);
  }

  await pool.end();

  console.log(`\nImport complete.`);
  console.log(`  Total lines processed: ${lineNum.toLocaleString()}`);
  console.log(`  Rows sent to DB: ${totalInserted.toLocaleString()}`);
  console.log(`  Skipped (no mapping): ${skippedNoMapping.toLocaleString()}`);
  console.log(`  Skipped (invalid data): ${skippedInvalid.toLocaleString()}`);
  console.log(`  (Duplicates auto-skipped by ON CONFLICT DO NOTHING)`);
}

async function insertBatch(pool: Pool, batch: string[][]): Promise<void> {
  // Build a multi-row INSERT with parameterized values
  const values: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  for (const row of batch) {
    values.push(
      `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6})`,
    );
    params.push(
      parseInt(row[0]), // instrumentId
      row[1], // date
      parseFloat(row[2]), // open
      parseFloat(row[3]), // high
      parseFloat(row[4]), // low
      parseFloat(row[5]), // close
      row[6], // volume (as string — pg handles bigint conversion)
    );
    paramIdx += 7;
  }

  const sql = `
    INSERT INTO "StockPrice" ("instrumentId", "date", "open", "high", "low", "close", "volume")
    VALUES ${values.join(",")}
    ON CONFLICT ("instrumentId", "date") DO NOTHING
  `;

  await pool.query(sql, params);
}

async function main() {
  // Load .env
  require("dotenv").config();

  console.log("=== Colleague Data Import ===");
  console.log(`Stocks mapping: ${STOCKS_CSV}`);
  console.log(`Prices file: ${PRICES_CSV}`);

  // Build mapping from stocks.csv (csvId → börsdataId)
  const mapping = new Map<number, number>();

  await createMissingInstruments(mapping);
  await prisma.$disconnect();
  await importPrices(mapping);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
