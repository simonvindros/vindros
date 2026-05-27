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
1. Price must be ≥ 10 SEK (liquidity filter)
2. Slope must be > 0 (stock must be in an uptrend)
3. Rank all qualifying stocks by slope descending
4. Hold the top 10

### No fundamental filter
Large/Mid cap stocks are liquid and well-covered. Pure momentum works — let slope pick the winners.

---

## Pool 2: Fundamentals (Small Cap) — 5 slots

### Universe
All Swedish stocks on Small Cap (market 3), First North (market 4), and Spotlight (market 5).

### Two-stage qualification

#### Stage 1: Annual Baseline (gets stocks IN)
A stock must pass ALL of these on trailing annual report data:

| Criterion | Threshold |
|-----------|-----------|
| Revenue growth (avg last 5 years) | > 15% |
| Negative growth years (last 4) | ≤ 1 allowed |
| Extreme spikes/crashes | No year > +200% or < -30% |
| Revenue (latest year) | > 50 MSEK |
| Operating margin (latest year) | > 5% |
| Operating margin trend | Improving vs 4 years ago |
| Data history required | ≥ 4 years |

#### Stage 2: Quarterly Freshness Check (kicks stocks OUT)
Re-evaluated every quarter. A stock that passed annual baseline gets disqualified if:

| Criterion | Disqualified if... |
|-----------|-------------------|
| Latest quarter revenue growth | < -10% |
| Latest quarter operating margin | < 0% |

**Reporting lag:** 1 quarter. In Q2, we use data up to Q1 (just reported). This prevents look-ahead bias.

#### Ranking
Among qualified small caps, rank by the same 90-day regression slope. Hold the top 5.

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

| Parameter | Value |
|-----------|-------|
| Initial capital | 20,000 SEK |
| Monthly contribution | 5,000 SEK |
| Contribution day | 23rd (or prior trading day) |
| Contribution allocation | Distributed across all positions at next rebalance |

Both portfolio and benchmark receive the same monthly contributions (fair DCA comparison).

---

## The Momentum Signal: Linear Regression Slope

We fit a least-squares linear regression to the last 90 closing prices:

$$\text{slope} = \frac{n \sum x_i y_i - \sum x_i \sum y_i}{n \sum x_i^2 - (\sum x_i)^2}$$

where $x_i$ = day index (0 to 89), $y_i$ = closing price.

The slope is annualized: `slope × 252` (trading days/year).

**Why regression slope over other momentum measures (e.g., ROC, moving average crossover)?**
- Captures the *rate* of price change, not just direction
- Smooth signal — less whipsaw than MA crossovers
- Higher slope = steeper uptrend = stronger momentum
- Negative slope = immediate disqualification (no shorts)

Minimum 60 data points required (roughly 3 months of history) for the regression to be meaningful.

---

## Qualification Frequency

| Pool | Qualification | Re-check frequency |
|------|--------------|-------------------|
| Core (Large/Mid) | Slope > 0, price ≥ 10 | Every month (at rebalance) |
| Fundamentals (Small) | Annual baseline + quarterly freshness | Every quarter |

The quarterly freshness check means a small cap showing deterioration in its latest quarterly report gets removed within 3 months, rather than waiting up to 12 months for the next annual report.

---

## Benchmark

OMXSPI (Stockholm All-Share Index, instrument ID 638). Same DCA contributions applied to benchmark for fair comparison.

---

## Backtest Results (Jan 2018 – May 2026)

| Metric | Value |
|--------|-------|
| Total contributed | 525,000 SEK |
| Final portfolio value | 1,618,021 SEK |
| Portfolio return | +208.2% |
| Benchmark return (OMXSPI) | +43.6% |
| **Alpha** | **+164.6%** |
| Max drawdown | 35.2% |
| Total trades | 584 |
| Win rate | 49.5% |
| Profit factor | 1.30 |
| Avg winning trade | +22.6% |
| Avg losing trade | -11.6% |

### Pool breakdown
| Pool | Trades | Win Rate | Avg Return |
|------|--------|----------|------------|
| Large/Mid | 476 | 47.9% | +4.0% |
| Small (fundamental) | 108 | 56.5% | +11.2% |

---

## Why It Works

1. **Momentum is persistent** — stocks in strong uptrends tend to continue (well-documented factor)
2. **Fundamental filter removes trash** — small caps without real revenue growth, margins, and size are excluded
3. **Quarterly freshness catches deterioration early** — don't ride a winner turned loser all year
4. **Equal weight forces discipline** — rebalance sells winners that grew too large, buys laggards catching up
5. **Monthly contributions compound** — DCA + momentum = systematic exposure to the strongest trends
6. **Reserved slots guarantee exposure** — small caps can't be crowded out by large caps (they compete within their own pool)
