---
description: "Design a backtest strategy definition using KPI filters, date ranges, and rebalance rules. Use when planning or implementing a quant screening strategy."
agent: "agent"
argument-hint: "Describe your strategy (e.g. low P/E, high ROE, rebalance quarterly)"
---

Design a backtest strategy for the Vindros quant app based on the user's description.

## Context
- Available KPIs and their meanings: [docs/kpi-guide.md](../../docs/kpi-guide.md)
- KPI filter definitions: [backend/src/config/kpiCombinations.ts](../../backend/src/config/kpiCombinations.ts)
- Database schema: [backend/prisma/schema.prisma](../../backend/prisma/schema.prisma)
- Each KPI value has dimensions: `reportType` (year, r12, quarter) and `priceType` (mean, high, low)

## Output
For the described strategy, produce:
1. **Filter criteria** — which KPIs, thresholds, and reportType/priceType to use
2. **Universe** — any market/sector/country constraints
3. **Rebalance rule** — frequency (monthly, quarterly, yearly) and timing
4. **Ranking** — how to rank qualifying stocks if a portfolio size limit is needed
5. **Considerations** — survivorship bias, look-ahead bias, and data availability caveats

Explain the financial reasoning behind each filter choice. Never give financial advice — teach the concepts.
