# Clenow Momentum Strategy

Andreas Clenow — Swedish quant based in Zurich. Strategy from his book _"Stocks on the Move"_.

## Overview

A pure **technical/momentum** strategy. No fundamentals — only price data.

Three components:

1. **Market filter** — only invest when the index is trending up
2. **Momentum ranking** — rank all stocks by trend strength and smoothness
3. **Position sizing** — volatile stocks get smaller positions

---

## 1. Market Filter (SMA 200)

If the index (OMXSPI) is **below** its 200-day Simple Moving Average, go to cash. Don't buy anything.

### Simple Moving Average (SMA)

The average close price over the last 200 trading days:

$$SMA_{200} = \frac{1}{200} \sum_{i=0}^{199} P_{t-i}$$

- $P$ = close price
- $t$ = today
- $P_{t-i}$ = price $i$ days ago

In code: take a sliding window of 200 prices, sum them, divide by 200.

**Signal:**

- Index price > SMA 200 → **invest** (green light)
- Index price < SMA 200 → **cash** (red light)

**Example (2020):** OMXSPI dropped below SMA 200 on March 5–6 (COVID crash). Stayed below until June 16. The filter keeps you out of the worst of the crash.

---

## 2. Momentum Ranking

For each stock, calculate: **Annualized regression slope × R²**

This requires three concepts: logarithm, linear regression, and R².

### Why Logarithm?

Stock prices grow in percentages, not absolute numbers. A stock going from 10 → 20 (+100%) should rank the same as 100 → 200 (+100%).

Without log, regression on raw prices gives a slope proportional to the price level — a 200kr stock always gets a bigger slope than a 10kr stock, even with the same percentage gain.

`Math.log()` (natural logarithm) converts prices so that equal percentage changes produce equal values:

```
Price:     100  →  150  →  225   (×1.5 each time)
Log price: 4.60 → 5.01 → 5.42   (+0.41 each time, linear)
```

### Linear Regression

Given 90 days of log prices, find the **best-fit straight line** through all 90 points.

Each point:

- **x** = day number (0, 1, 2, ..., 89)
- **y** = `Math.log(close)` for that day

The slope of the best-fit line tells you how fast the stock is trending up (or down).

#### The Slope Formula

$$slope = \frac{n \sum xy - \sum x \sum y}{n \sum x^2 - (\sum x)^2}$$

Where $n$ = 90 (number of days).

#### What each sum means

| Symbol | Meaning | Code |
|--------|---------|------|
| $\sum x$ | Sum of all day numbers: $0 + 1 + 2 + ... + 89$ | `xAxis.reduce((sum, x) => sum + x, 0)` |
| $\sum y$ | Sum of all log prices | `yAxis.reduce((sum, y) => sum + y, 0)` |
| $\sum xy$ | For each day, multiply day × log price, then sum all | `xAxis.reduce((sum, x, i) => sum + x * yAxis[i], 0)` |
| $\sum x^2$ | For each day, square the day number, then sum all | `xAxis.reduce((sum, x) => sum + x * x, 0)` |

#### Why the top part works (covariance)

The top part ($n \sum xy - \sum x \sum y$) measures whether time and price move together.

**Example — stock going up (4 days):**

| Day (x) | Price (y) | x × y |
|---------|----------|-------|
| 0 | 1 | 0 |
| 1 | 2 | 2 |
| 2 | 3 | 6 |
| 3 | 4 | 12 |

- $n \sum xy = 4 \times 20 = 80$
- $\sum x \times \sum y = 6 \times 10 = 60$
- Top part: $80 - 60 = 20$ → **positive** (price goes up over time)

**Stock going down:**

| Day (x) | Price (y) | x × y |
|---------|----------|-------|
| 0 | 4 | 0 |
| 1 | 3 | 3 |
| 2 | 2 | 4 |
| 3 | 1 | 3 |

- $n \sum xy = 4 \times 10 = 40$
- $\sum x \times \sum y = 6 \times 10 = 60$
- Top part: $40 - 60 = -20$ → **negative** (price goes down over time)

**Stock going nowhere:**

| Day (x) | Price (y) | x × y |
|---------|----------|-------|
| 0 | 2 | 0 |
| 1 | 2 | 2 |
| 2 | 2 | 4 |
| 3 | 2 | 6 |

- $n \sum xy = 4 \times 12 = 48$
- $\sum x \times \sum y = 6 \times 8 = 48$
- Top part: $48 - 48 = 0$ → **zero** (no trend)

**Intuition:** $\sum x \times \sum y$ is the "expected" value if there were no relationship between time and price. $n \sum xy$ is the "actual" value. The difference tells you direction and strength.

#### Why the bottom part exists

The bottom part ($n \sum x^2 - (\sum x)^2$) normalizes the result so the slope is expressed as "change per day." Since x is always 0–89, this is a constant for any 90-day window.

#### Annualizing the Slope

The raw slope is per-day change in log-price. To convert to annual percentage return:

$$annualized = (e^{slope \times 252} - 1) \times 100$$

252 = trading days per year. $e^{slope \times 252}$ converts from log-space back to a growth multiplier.

### R² (Coefficient of Determination)

R² measures how well the regression line fits the data. Range: 0 to 1.

- **R² = 1.0** — all points sit perfectly on the line (smooth trend)
- **R² = 0.5** — half the movement follows the trend, half is noise
- **R² = 0.0** — completely random, no trend at all

**Why it matters:** Two stocks can both have a slope of +0.005/day:

- Stock A: goes up a little every day → high R²
- Stock B: crashes 20%, spikes 30%, crashes again → low R²

Same slope, very different risk. Clenow multiplies slope × R² to penalize erratic stocks.

**Final momentum score = annualized slope × R²**

---

## 3. Position Sizing (ATR)

ATR = Average True Range. Measures daily volatility.

- Volatile stocks → smaller position
- Stable stocks → bigger position

This equalizes risk across the portfolio — each position contributes roughly the same amount of risk.

---

## 4. Rules Summary

| Rule | Detail |
|------|--------|
| Market filter | OMXSPI above 200-day SMA → invest. Below → cash. |
| Buy | Top 20–30 stocks ranked by (annualized slope × R²) |
| Individual exit | Stock drops below its 100-day moving average → sell |
| Rebalance | Every 2 weeks: re-rank, sell losers, buy new top-ranked |
| Sizing | Based on ATR — less in volatile stocks, more in stable ones |

---

## Key Concepts

- **Momentum**: stocks going up tend to keep going up (medium-term, 3–12 months)
- **This is pure technical analysis** — no fundamentals (P/E, ROC, etc.)
- **Slope** = direction and speed of the trend
- **R²** = confidence that the trend is real (smooth vs chaotic)
- **SMA** = smoothed average price to filter noise from trend

---

## Caveats

- Momentum crashes: when the trend reverses, momentum strategies can lose fast. The market filter and 100-day MA exit are the protection.
- Transaction costs: biweekly rebalancing means frequent trading.
- Works best in trending markets. Choppy/sideways markets produce many false signals.
