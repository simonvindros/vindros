# AGENTS.md

## Project Overview

Vindros is a quant backtest app. The backend ingests Swedish stock market data from the [Börsdata API](https://apiservice.borsdata.se/v1) into a PostgreSQL database. The frontend is not yet started.

Two strategy variants are implemented:

- **Vindros Baseline (15-pos)** — 15 equal-weight positions, monthly rebalance
- **Vindros Dynamic (3-slot)** — 3 concentrated positions with ADV overflow, A→B substitution. Kept running as a paper-trade baseline; current research direction is measuring individual signals (Information Coefficient) before building a new portfolio strategy — see [docs/quant-curriculum.md](docs/quant-curriculum.md) and [docs/signal-ic-results.md](docs/signal-ic-results.md).

Domain knowledge for the financial KPIs (P/E, P/S, margins, etc.) is documented in [docs/kpi-guide.md](docs/kpi-guide.md).

## Tech Stack

- **Backend**: TypeScript, Express, Prisma 7 (with `@prisma/adapter-pg`)
- **GraphQL**: Apollo Server, wired up in `src/index.ts` and served at `/graphql`
- **Database**: PostgreSQL 15 (Docker)
- **Runtime**: Node.js with CommonJS modules (`"type": "commonjs"` in package.json)
- **Target**: ES2020

## Getting Started

```bash
cd backend
cp .env.example .env   # Then set BORSDATA_API_KEY
npm install
npm run setup           # Starts Docker + waits for Postgres + runs migrations
npm run seed            # Seeds data from Börsdata API (resumable — run again to continue)
npm run dev             # Express server on :4000
```

## Key Commands (backend/)

| Command                  | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `npm run setup`          | Start Postgres container + run Prisma migrations  |
| `npm run seed`           | Seed all data (resumable via progress JSON files) |
| `npm run dev`            | Start Express dev server                          |
| `npm run prisma:migrate` | Run `prisma migrate dev`                          |
| `npm run prisma:studio`  | Open Prisma Studio GUI                            |
| `npm run clear:prices`   | Clear stock price data                            |
| `npm run update:prices`  | Fetch latest stock prices for all instruments     |
| `npm run start:all`      | Dev server + Prisma Studio concurrently           |

## Architecture

```
backend/
  prisma/schema.prisma        # Source of truth for DB schema
  generated/prisma/            # Generated Prisma client (do not edit)
  src/
    index.ts                   # Express + Apollo Server entrypoint
    graphql/                   # typeDefs + resolvers
    config/kpiCombinations.ts  # KPI filter definitions
    lib/
      api.ts                   # Axios client for Börsdata API
      prisma.ts                # Prisma client singleton
      progress.ts              # Resumable seed progress tracker
      chunks.ts                # Array chunking utility
    strategy/
      vindros.ts               # Signal ranking + monthly portfolio simulation
    utils/                     # Pure, tested helpers (regression, portfolio math, etc.)
    seed/                      # Seed scripts (run in order via main.ts)
    scripts/                   # Incremental update / maintenance scripts
frontend/                      # Not started yet
```

## Database

Prisma schema at [backend/prisma/schema.prisma](backend/prisma/schema.prisma). Core models:

- **Instrument** — A stock (ticker, ISIN, sector, market, country)
- **StockPrice** — OHLCV daily prices per instrument
- **KpiMetadata** — KPI definitions (P/E, P/S, P/B, etc.)
- **KpiValue** — KPI values per instrument/year/reportType/priceType
- **Market**, **Sector**, **Country** — Reference data

After schema changes, run `npm run prisma:migrate` from `backend/`.

## Conventions

- Environment variables via `.env` (never commit): `DATABASE_URL`, `BORSDATA_API_KEY`
- Prisma client is generated to `backend/generated/prisma/` — do not edit generated files
- Seed scripts are **resumable**: progress is tracked in `*-progress.json` files at `backend/`. Run `npm run seed` multiple times to complete large imports.
- Seed order matters (countries → markets → sectors → instruments → kpiMetadata → stockPrices → kpiValues)
- The Börsdata API has rate limits; seed scripts use batching and chunk processing
- Docker container: `vindros_quant_container` (Postgres user/pass/db: `postgres`/`postgres`/`vindros_quant`)
- `ts-node` is used for all dev execution (no build step needed during development)
- No test framework yet
