# Vindros — System Documentation

## Overview

Vindros is a monthly-rebalanced momentum system that trades Swedish stocks across two pools with fixed slot allocations. It combines price momentum (regression slope) with fundamental quality filtering.

**Portfolio: 15 positions total**

- 10 slots → Large Cap + Mid Cap (pure momentum)
- 5 slots → Small Cap / First North / Spotlight (momentum + fundamental filter)

---

## Pool 1: Core (Large/Mid Cap) — 10 slots

### Universe

All Swedish stocks on Large Cap (market 1) and Mid Cap (market 2).

### Ranking Signal

90-day linear regression slope of closing prices, annualized (×252).

### Rules

1. Price must be ≥ 10 SEK
2. Stale price guard: stock must have traded within last 7 calendar days (filters delisted/suspended)
3. Slope must be > 0 (stock must be in an uptrend)
4. Rank all qualifying stocks by slope descending
5. Hold the top 10

### No fundamental filter

Large/Mid cap stocks are liquid and well-covered. Pure momentum works — let slope pick the winners.

---

## Pool 2: Fundamentals (Small Cap) — 5 slots

### Universe

All Swedish stocks on Small Cap (market 3), First North (market 4), and Spotlight (market 5).

### Two-stage qualification

#### Stage 1: Annual Baseline (gets stocks IN)

A stock must pass ALL of these on trailing annual report data:

| Criterion                         | Threshold                 |
| --------------------------------- | ------------------------- |
| Revenue growth (avg last 5 years) | > 15%                     |
| Negative growth years (last 4)    | ≤ 1 allowed               |
| Extreme spikes/crashes            | No year > +200% or < -30% |
| Revenue (latest year)             | > 50 MSEK                 |
| Operating margin (latest year)    | > 5%                      |
| Operating margin trend            | Improving vs 4 years ago  |
| Data history required             | ≥ 4 years                 |

#### Stage 2: Quarterly Freshness Check (kicks stocks OUT)

Re-evaluated every quarter. A stock that passed annual baseline gets disqualified if:

| Criterion                       | Disqualified if... |
| ------------------------------- | ------------------ |
| Latest quarter revenue growth   | < -10%             |
| Latest quarter operating margin | < 0%               |

**Reporting lag:** 1 quarter. In Q2, we use data up to Q1 (just reported). This prevents look-ahead bias.

#### Ranking

Among qualified small caps, rank by the same 90-day regression slope. Hold the top 5.

#### Liquidity Filter (Small Caps only)

Before ranking, each candidate is checked:

- Compute 20-day average daily value (ADV): `mean(close × volume)` over last 20 trading days
- Estimate position size: `current portfolio value ÷ 15`
- **Reject if:** position size > 10% of ADV

This prevents entering positions that would take multiple days to exit. Large/Mid caps are exempt (always liquid enough).

#### Stale Price Guard

Same as Core pool: any stock whose last available price is >7 calendar days before the target date is skipped (delisted or suspended).

---

## Rebalancing

### Timing

- **When:** Last trading day of each month
- **Salary injection:** 5,000 SEK added on or before the 23rd of each month

### Process (each rebalance)

1. Compute target portfolio (top 10 core + top 5 fundamentals)
2. **Sell** any held position NOT in the new target set
3. Compute equal-weight target: total portfolio value ÷ 15
4. **Trim** positions that are >1% overweight
5. **Top up** positions that are >1% underweight
6. **Buy** new entries at target weight

### Weighting

Equal weight across all 15 positions. Each stock gets ~6.7% of portfolio value.

---

## Capital Management

| Parameter               | Value                                              |
| ----------------------- | -------------------------------------------------- |
| Initial capital         | 20,000 SEK                                         |
| Monthly contribution    | 5,000 SEK                                          |
| Contribution day        | 23rd (or prior trading day)                        |
| Contribution allocation | Distributed across all positions at next rebalance |

Both portfolio and benchmark receive the same monthly contributions (fair DCA comparison).

---

## The Momentum Signal: Linear Regression Slope

We fit a least-squares linear regression to the last 90 closing prices:

$$\text{slope} = \frac{n \sum x_i y_i - \sum x_i \sum y_i}{n \sum x_i^2 - (\sum x_i)^2}$$

where $x_i$ = day index (0 to 89), $y_i$ = closing price.

The slope is annualized: `slope × 252` (trading days/year).

**Why regression slope over other momentum measures (e.g., ROC, moving average crossover)?**

- Captures the _rate_ of price change, not just direction
- Smooth signal — less whipsaw than MA crossovers
- Higher slope = steeper uptrend = stronger momentum
- Negative slope = immediate disqualification (no shorts)

Minimum 60 data points required (roughly 3 months of history) for the regression to be meaningful.

---

## Qualification Frequency

| Pool                 | Qualification                         | Re-check frequency         |
| -------------------- | ------------------------------------- | -------------------------- |
| Core (Large/Mid)     | Slope > 0, price ≥ 10                 | Every month (at rebalance) |
| Fundamentals (Small) | Annual baseline + quarterly freshness | Every quarter              |

The quarterly freshness check means a small cap showing deterioration in its latest quarterly report gets removed within 3 months, rather than waiting up to 12 months for the next annual report.

---

## Benchmark

OMXSPI (Stockholm All-Share Index, instrument ID 638). Same DCA contributions applied to benchmark for fair comparison.

---

## Backtest Results (Jan 2010 – May 2026)

| Metric                    | Value         |
| ------------------------- | ------------- |
| Period                    | 197 months    |
| Total contributed         | 1,005,000 SEK |
| Final portfolio value     | 8,688,048 SEK |
| Portfolio return          | +764.5%       |
| Benchmark return (OMXSPI) | +108.5%       |
| **Alpha**                 | **+656.0%**   |
| Max drawdown              | 36.4%         |
| Total trades              | 960           |
| Win rate                  | 56.8%         |
| Profit factor             | 1.13          |

### Annual Breakdown

| Year   | Portfolio | Benchmark | Alpha  |
| ------ | --------- | --------- | ------ |
| 2010   | +17.6%    | +23.8%    | -6.2%  |
| 2011   | -20.8%    | -15.0%    | -5.8%  |
| 2012   | +16.7%    | +11.7%    | +5.0%  |
| 2013   | +46.2%    | +22.8%    | +23.4% |
| 2014   | +17.6%    | +11.9%    | +5.7%  |
| 2015   | +103.9%   | +5.8%     | +98.1% |
| 2016   | +13.8%    | +6.4%     | +7.4%  |
| 2017   | +25.3%    | +6.1%     | +19.2% |
| 2018   | -10.0%    | -8.0%     | -2.0%  |
| 2019   | +22.7%    | +29.3%    | -6.6%  |
| 2020   | +61.1%    | +13.4%    | +47.7% |
| 2021   | +69.3%    | +34.7%    | +34.6% |
| 2022   | +6.7%     | -24.3%    | +31.0% |
| 2023   | -6.7%     | +15.5%    | -22.2% |
| 2024   | +14.0%    | +5.6%     | +8.4%  |
| 2025   | +22.7%    | +9.6%     | +13.1% |
| 2026\* | +1.4%     | +5.3%     | -3.9%  |

_Partial year_

### Key Characteristics

- Positive alpha in 12 of 17 years (71%)
- No 3-year rolling window has negative cumulative alpha
- Worst single year: 2023 (-22.2% alpha) — broad market rotation away from momentum
- Best single year: 2015 (+98.1% alpha)

---

## Why It Works

1. **Momentum is persistent** — stocks in strong uptrends tend to continue (well-documented factor)
2. **Fundamental filter removes trash** — small caps without real revenue growth, margins, and size are excluded
3. **Quarterly freshness catches deterioration early** — don't ride a winner turned loser all year
4. **Equal weight forces discipline** — rebalance sells winners that grew too large, buys laggards catching up
5. **Monthly contributions compound** — DCA + momentum = systematic exposure to the strongest trends
6. **Reserved slots guarantee exposure** — small caps can't be crowded out by large caps (they compete within their own pool)
7. **Liquidity filter prevents illiquid traps** — won't enter positions you can't exit within a day
8. **Stale price guard auto-exits dead stocks** — delisted/suspended instruments are dropped within one rebalance cycle
