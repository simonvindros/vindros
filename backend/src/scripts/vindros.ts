/**
 * VINDROS — Full pipeline runner
 *
 * 1. Ensure Docker/Postgres is running
 * 2. Update stock prices (backfill + latest)
 * 3. Update KPIs (revenue growth, op margin, revenue)
 * 4. Run full analysis (monthly logbook)
 * 5. Output actionable signals
 */
import dotenv from "dotenv";
dotenv.config();

import { execSync } from "node:child_process";

function step(label: string) {
  console.log(`\n${"━".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"━".repeat(60)}\n`);
}

function runTs(script: string) {
  execSync(
    `TS_NODE_COMPILER_OPTIONS='{"rootDir":"."}' npx ts-node --transpileOnly ${script}`,
    { stdio: "inherit", cwd: __dirname + "/../.." },
  );
}

async function main() {
  const startTime = Date.now();
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║              VINDROS — Monthly Pipeline                 ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // 1. Docker
  step("1/5  Ensuring Docker + Postgres are running");
  try {
    const running = execSync(
      "docker ps -q --filter name=vindros_quant_container",
      {
        encoding: "utf-8",
      },
    ).trim();
    if (running) {
      console.log("  ✓ Postgres container already running");
    } else {
      console.log("  Starting Docker + Postgres...");
      execSync("npm run docker:up", {
        stdio: "inherit",
        cwd: __dirname + "/../..",
      });
      console.log("  ✓ Postgres started");
    }
  } catch {
    console.log("  Starting Docker + Postgres...");
    execSync("npm run docker:up", {
      stdio: "inherit",
      cwd: __dirname + "/../..",
    });
    console.log("  ✓ Postgres started");
  }

  // 2. Update prices
  step("2/5  Updating stock prices");
  runTs("src/scripts/updatePrices.ts");

  // 3. Update KPIs
  step("3/6  Updating KPI values");
  runTs("src/scripts/updateKpis.ts");

  // 4. Compute indicators
  step("4/6  Computing technical indicators (slope, EMA)");
  runTs("src/scripts/computeIndicators.ts");

  // 5. Run analysis (logbook)
  step("5/6  Running Vindros analysis (full backtest logbook)");
  runTs("src/backtest/vindros_analysis.ts");

  // 6. Signals
  step("6/6  Computing actionable signals");
  runTs("src/scripts/vindrosSignals.ts");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n${"━".repeat(60)}`);
  console.log(`  ✓ VINDROS COMPLETE (${elapsed}s)`);
  console.log(`${"━".repeat(60)}`);
  console.log(`\n  Outputs:`);
  console.log(`    • Analysis:  src/backtest/vindros_analysis_output.txt`);
  console.log(`    • Signals:   vindros_signals.txt`);
  console.log(
    `    • Portfolio: vindros_portfolio.json (update after trading)\n`,
  );
}

main().catch((err) => {
  console.error("\n✗ Pipeline failed:", err.message);
  process.exit(1);
});
