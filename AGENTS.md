# AGENTS.md

## Project Overview

Vindros is a quant backtest app. The backend ingests Swedish stock market data from the [Börsdata API](https://apiservice.borsdata.se/v1) into a PostgreSQL database. The frontend is not yet started.

## Tech Stack

- **Backend**: TypeScript, Express, Apollo Server (GraphQL), Prisma 7 (with `@prisma/adapter-pg`)
- **Database**: PostgreSQL 15 (Docker)
- **Runtime**: Node.js with CommonJS modules (`"type": "commonjs"` in package.json)
- **Target**: ES2020

## Getting Started

```bash
cd backend
cp .env.example .env   # Set DATABASE_URL and BORSDATA_API_KEY
npm install
npm run setup           # Starts Docker + waits for Postgres + runs migrations
npm run seed            # Seeds data from Börsdata API (resumable — run again to continue)
npm run dev             # Express server on :4000
```

## Key Commands (backend/)

| Command | Purpose |
|---------|---------|
| `npm run setup` | Start Postgres container + run Prisma migrations |
| `npm run seed` | Seed all data (resumable via progress JSON files) |
| `npm run dev` | Start Express dev server |
| `npm run prisma:migrate` | Run `prisma migrate dev` |
| `npm run prisma:studio` | Open Prisma Studio GUI |
| `npm run clear:prices` | Clear stock price data |
| `npm run start:all` | Dev server + Prisma Studio concurrently |

## Architecture

```
backend/
  prisma/schema.prisma        # Source of truth for DB schema
  generated/prisma/            # Generated Prisma client (do not edit)
  src/
    index.ts                   # Express + Apollo Server entrypoint
    config/kpiCombinations.ts  # KPI filter definitions
    lib/
      api.ts                   # Axios client for Börsdata API
      prisma.ts                # Prisma client singleton
      progress.ts              # Resumable seed progress tracker
      chunks.ts                # Array chunking utility
    seed/                      # Seed scripts (run in order via main.ts)
    scripts/                   # One-off maintenance scripts
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
