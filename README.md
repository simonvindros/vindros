# Vindros

A Nordic equities quant research and backtesting project. Built to learn real backend/data-engineering practices, with the actual goal of beating the market (and the average trader on Avanza).

## What this is

Vindros pulls Swedish (and broader Nordic) stock market data, daily prices, fundamentals (KPIs), and quarterly reports, from the [Börsdata API](https://apiservice.borsdata.se/v1) into PostgreSQL via Prisma, and exposes it through a GraphQL API. That data is used to measure and backtest trading signals.

- **Backend**: TypeScript, Express, Prisma 7, GraphQL (Apollo Server)
- **Database**: PostgreSQL, seeded and kept up to date via resumable scripts
- **Research**: signal measurement (Information Coefficient), grounded in actual academic quant literature. See [docs/](docs/)
- **Frontend**: not started yet

## Status

Scaled back and under construction. The earlier "Vindros Dynamic" concentrated-momentum strategy has been retired. Right now the focus is measuring individual signals (profitability, momentum, value) with Information Coefficient, before building any new portfolio strategy. See [docs/quant-curriculum.md](docs/quant-curriculum.md) and [docs/signal-ic-results.md](docs/signal-ic-results.md).

## Getting started

See [AGENTS.md](AGENTS.md) for full setup instructions, architecture, and conventions.

```bash
cd backend
cp .env.example .env   # then set BORSDATA_API_KEY
npm install
npm run setup           # Docker + migrations
npm run seed             # Seeds data (resumable)
npm run dev              # Express + GraphQL on :4000
```

## Docs

- [docs/kpi-guide.md](docs/kpi-guide.md): plain-language guide to every financial metric used
- [docs/quant-foundations.md](docs/quant-foundations.md): academic foundations (Grinold & Kahn, backtest overfitting, factor research)
- [docs/quant-curriculum.md](docs/quant-curriculum.md): the current research plan
- [docs/signal-ic-results.md](docs/signal-ic-results.md): measured signal results so far
