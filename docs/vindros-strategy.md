# Vindros Strategy

A monthly-rebalanced momentum system for Swedish equities. 15 equal-weight positions selected from a unified pool ranked by price trend strength, with a fundamental quality gate applied to small caps.

**Live since:** May 2026  
**Backtest period:** Jan 2010 – May 2026 (197 months)  
**Backtest result:** +1,162% return, +1,054% alpha vs OMXSPI

---

## How It Works (Plain English)

Every month-end, we ask: "Which 15 Swedish stocks have the steepest, smoothest uptrend right now?"

We measure this using **linear regression** on the last 90 days of prices. The slope tells us _how fast_ the stock is rising; the R² tells us _how consistently_ it's rising. A stock going up chaotically (R² < 0.6) doesn't qualify — we only want clean, reliable trends.

Small caps need an additional filter: they must prove they're real businesses (growing revenue, profitable, not a speculative mess) before we'll consider their momentum signal.

Each month we equal-weight all 15 positions, selling what dropped out and buying what entered.

---

## Universe

| Pool      | Markets                                       | Count       |
| --------- | --------------------------------------------- | ----------- |
| Large/Mid | Large Cap (1), Mid Cap (2)                    | ~250 stocks |
| Small     | Small Cap (3), First North (4), Spotlight (5) | ~450 stocks |

All pools are unified into one ranking. A stock from any pool can take any of the 15 slots. In practice, Large/Mid dominates because more stocks pass the criteria.

---

## The Momentum Signal

### Linear Regression Slope

We fit a least-squares line to the last 90 closing prices (log scale):

$$\ln(\text{price}_i) = \alpha + \beta \cdot i + \epsilon$$

- **β (slope)** — the daily rate of price increase. Annualized by multiplying by 252 (trading days/year). A slope of 1.0 means the stock is trending upward at ~100% annualized pace.
- **R² (coefficient of determination)** — how much of the price movement is explained by the trend line. Ranges from 0 (random noise) to 1 (perfectly straight line). We require **R² ≥ 0.6**.

### Why R² matters

Without R², a stock that crashed 50% then recovered 60% could have a positive slope — but that's not momentum, that's volatility. R² ensures the uptrend is _consistent_. It acts as a built-in quality filter that makes stop-losses unnecessary.

### Why 90 days?

- Shorter (e.g., 20 days): too noisy, whipsaw on every pullback
- Longer (e.g., 200 days): too slow, misses the early part of new trends
- 90 days: captures ~4 months of trend, balances responsiveness with stability

### Ranking

All qualifying stocks are ranked by slope descending. The top 15 become the target portfolio. Pure slope ranking — no weighting by R² or other factors.

---

## Filters

### Universal Filters (all stocks)

| Filter        | Value             | Why                                                                 |
| ------------- | ----------------- | ------------------------------------------------------------------- |
| Minimum price | ≥ 10 SEK          | Excludes penny stocks with erratic price action                     |
| Minimum R²    | ≥ 0.6             | Rejects choppy/unreliable trends                                    |
| Minimum data  | ≥ 60 trading days | Need enough history for a meaningful regression                     |
| Slope         | > 0               | Must be in an uptrend (implicit — negative slope can't rank top 15) |

### Liquidity Filter (all stocks)

| Metric                           | Rule                                             |
| -------------------------------- | ------------------------------------------------ |
| 20-day average daily value (ADV) | `mean(close × volume)` over last 20 trading days |
| Position size                    | `portfolio value ÷ 15`                           |
| **Reject if**                    | position size > 10% of ADV                       |

This ensures you can exit any position within a single day without moving the market. In practice, this mostly constrains small caps.

### Fundamental Quality Gate (Small Caps only)

Small/micro-cap momentum is dangerous without fundamental backing — many small cap "rockets" are speculative garbage that crashes as fast as it rose. The quality gate ensures we only ride momentum in _real businesses_.

#### Annual Baseline (entry qualification)

All criteria evaluated on the latest available annual report data:

| KPI                            | Threshold                | What it means                                             |
| ------------------------------ | ------------------------ | --------------------------------------------------------- |
| Revenue growth (5yr avg)       | > 10%                    | The company is actually growing, not a stagnant micro-cap |
| Negative growth years (last 4) | ≤ 1                      | Growth is consistent, not a one-off spike                 |
| Revenue (latest year)          | > 50 MSEK                | Minimum scale — eliminates pre-revenue startups           |
| Operating margin (latest year) | > 5%                     | The company makes money, not burning cash                 |
| Operating margin trend         | Improving vs 4 years ago | Profitability is getting better, not deteriorating        |
| Data history                   | ≥ 3 years                | Enough track record to evaluate                           |

#### Quarterly Freshness Check (exit disqualification)

Re-evaluated every quarter. If a stock passed annual baseline but now shows:

| KPI                             | Disqualified if... | What it means                                 |
| ------------------------------- | ------------------ | --------------------------------------------- |
| Latest quarter revenue growth   | < -10%             | Revenue is shrinking — growth story is broken |
| Latest quarter operating margin | < 0%               | Losing money — fundamentals deteriorated      |

**Reporting lag:** 1 quarter. In Q2, we use Q1 data (just reported). Prevents look-ahead bias.

---

## KPIs Explained: What They Are and Why They're Here

The system uses three fundamental KPIs from the Börsdata database. Each serves a specific role in the quality gate:

### Revenue (KPI ID: 53)

**What it is:** Total money the company received from selling its products/services in a year, before any costs are subtracted. Also called "top line" or "omsättning" in Swedish.

**Unit:** MSEK (million SEK)

**Role in the system:** The `MIN_REVENUE_MSEK = 50` filter ensures minimum scale. A company with 50M+ SEK in annual revenue is a real operating business, not a shell company or pre-revenue startup. This eliminates the most dangerous micro-caps — companies with no product-market fit that happen to have rising stock prices on hype alone.

**Example:** A biotech with 2 MSEK revenue (from a single consulting contract) and a soaring stock price = rejected. A SaaS company with 80 MSEK revenue = passes.

### Revenue Growth (KPI ID: 94)

**What it is:** Year-over-year percentage change in revenue. A value of 25 means revenue grew 25% compared to the previous year.

**Unit:** Percent (%)

**Role in the system:** Used in two ways:

1. **Annual average > 10%** — the company must be growing structurally, not just riding a temporary demand spike
2. **Quarterly check > -10%** — if the latest quarter shows revenue falling more than 10%, the growth story may be over and we exit before the stock price catches up

**Why it matters for momentum:** Revenue growth is the most fundamental driver of stock prices over time. A company with accelerating revenue growth will _eventually_ see its stock price follow. By requiring growth, we ensure our momentum signal is backed by business reality — not just speculation.

**Example:** A stock with slope = 1.5 (strong uptrend) but revenue declining 20% per year = speculative momentum, rejected. Same slope but revenue growing 30% = fundamental momentum, accepted.

### Operating Margin (KPI ID: 29)

**What it is:** What percentage of revenue becomes operating profit (after paying salaries, rent, materials, but before tax and interest). Calculated as `EBIT ÷ Revenue × 100`.

**Unit:** Percent (%)

**Role in the system:** Used in two ways:

1. **Annual > 5%** — the company is actually profitable from operations
2. **Trend improving** — margin must be higher than 4 years ago (the business is getting _more_ efficient, not less)
3. **Quarterly check ≥ 0%** — if the company starts losing money operationally, exit

**Why it matters for momentum:** Revenue growth without profitability = cash burn. Many growth stocks rise on revenue growth alone but eventually crash when investors realize the company can't turn revenue into profit. Requiring a positive and improving operating margin eliminates these "growth traps."

**Example:** A company growing revenue 40%/year but with -15% operating margin (losing money on every sale) = rejected. Growing 15%/year with 8% operating margin improving from 3% = accepted.

### Why only three KPIs?

The system deliberately uses minimal fundamentals. More filters = more stocks rejected = smaller universe = weaker momentum signal. These three capture the essential question: _"Is this a real, growing, profitable business?"_ Everything else (P/E, debt ratios, return on equity) is noise for a momentum system — we don't care if the stock is "cheap" or "expensive," we care if the trend is strong and the business is real.

---

## Rebalancing

### Timing

**Last trading day of each month.**

Tested: month-end is optimal. Both the last day (+1,163%) and first day of next month (+1,073%) work well. Mid-month (e.g., the 15th) performs significantly worse (~+600%). This is likely the "turn-of-month effect" — institutional cash flows cluster around month boundaries.

### Process

1. Rank all qualifying stocks by slope
2. Take top 15 as target portfolio
3. **Sell** any held position no longer in top 15
4. **Buy** new entries
5. **Rebalance** all 15 positions to equal weight (portfolio value ÷ 15)

### Monthly Contribution

5,000 SEK added at each rebalance (simulating a monthly savings plan). Distributed equally across all 15 positions through the rebalance process.

---

## Position Sizing

**Equal weight.** Each of the 15 stocks gets exactly `portfolio_value ÷ 15` in target allocation.

Why equal weight over other schemes:

- **Simplicity**: no optimization, no parameter sensitivity
- **Automatic trimming**: winners that grew above target weight get sold down each month — this is how the system takes profits without a trailing stop
- **Automatic recovery**: if a position drops, its next-month allocation is the same dollar amount, which means more shares at a lower price
- **No single-stock blowup**: worst case is 6.7% of portfolio in one stock

---

## Why No Stop-Losses

The system has no daily stop-loss or trailing stop. This is deliberate:

1. **Momentum stocks are volatile.** A -8% week followed by +15% the next is normal. Stop-losses sell at the bottom.
2. **R² already filters quality.** Choppy stocks that would trigger stops repeatedly don't qualify in the first place.
3. **Monthly rebalance IS the exit.** A stock losing its trend will have falling slope → drops from top 15 → gets sold at next rebalance (max 1 month holding a loser).
4. **Equal-weight caps exposure.** The system trims positions monthly, so no single stock can grow to dominate the portfolio.
5. **Tested and proven.** Adding SMA50 filter halved returns. The "price of admission" is tolerating 9% monthly drawdowns for 1,162% total returns.

---

## Parameters

| Parameter            | Value      | Sensitivity                                                               |
| -------------------- | ---------- | ------------------------------------------------------------------------- |
| Total positions      | 15         | Optimal range 12–18; fewer = more concentrated risk, more = diluted alpha |
| Regression window    | 90 days    | Sweet spot; 60 too noisy, 120 too slow                                    |
| Min R²               | 0.6        | Key filter; 0.5 lets in too much noise, 0.7 rejects too many              |
| Min price            | 10 SEK     | Low sensitivity; just removes penny stocks                                |
| ADV fraction         | 10%        | Conservative; ensures single-day exits                                    |
| Min revenue growth   | 10%        | Moderate bar; eliminates stagnant companies                               |
| Min revenue          | 50 MSEK    | Eliminates pre-revenue shells                                             |
| Min operating margin | 5%         | Must be profitable                                                        |
| Min data years       | 3          | Enough KPI history to evaluate                                            |
| Monthly contribution | 5,000 SEK  | Configurable; doesn't affect strategy logic                               |
| Initial capital      | 20,000 SEK | Starting amount                                                           |

---

## Benchmark

**OMXSPI** (Stockholm All-Share Index, instrument ID 638). Same DCA contributions applied to the benchmark for fair comparison.

---

## Backtest Results (Jan 2010 – May 2026)

| Metric                        | Value           |
| ----------------------------- | --------------- |
| Period                        | 197 months      |
| Total contributed             | 1,005,000 SEK   |
| Final portfolio value         | ~12,700,000 SEK |
| Portfolio return              | +1,162.8%       |
| Benchmark return (OMXSPI DCA) | +108.5%         |
| **Alpha**                     | **+1,054.3%**   |

---

## Design Decisions & Lessons Learned

| Decision                      | Rationale                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Unified pool (not split 10/5) | Splitting slots reduces flexibility; unified lets the best stocks win regardless of market cap                                    |
| No EMA/SMA exit               | Tested SMA50 and EMA40 — both halved returns. Momentum stocks regularly dip below averages in healthy pullbacks                   |
| No pyramiding                 | Equal-weight outperforms. Adding to winners increases concentration risk without improving returns                                |
| No crash exit                 | A 9% monthly drawdown is normal for this return profile. Circuit breakers cause whipsaw                                           |
| Small cap quality gate        | Without it, small cap slots fill with speculative garbage that crashes. With it, small caps that qualify have legitimate momentum |
| Month-end rebalance           | Turn-of-month institutional flows provide better entry/exit prices. Mid-month rebalancing underperforms by ~50%                   |
