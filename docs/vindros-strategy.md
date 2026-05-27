# Vindros Strategy

## Universe

226 stocks on Swedish Large Cap + Mid Cap that were listed before 2018-01-01 (survivorship filter).

## Loop Structure

Iterates over every trading day. Most actions happen daily, but full rebalance only on month-end.

## Daily Checks (every trading day)

1. **Crash exit**: If a single position's one-day loss exceeds 10% of total portfolio value → sell immediately. (Safety net for catastrophic single-stock events.)

2. **Fill empty slots**: If there are open slots (< 10 positions) and cash available, buy into the current top candidates using the same ranking logic as monthly. Sizes positions equally by dividing cash by the number of candidates available.

## Monthly Rebalance (last trading day of each month)

1. **Contribution**: Add 5,000 SEK cash + buy equivalent in benchmark (DCA).

2. **EMA40 exits**: For each held position, if today's close < EMA40 → sell at close. This is the only routine exit mechanism.

3. **Score & rank candidates**: All stocks passing these filters qualify:
   - EMA20 > EMA40 (uptrend confirmed)
   - Price > EMA20 (momentum intact)
   - Price ≥ 10 SEK (no penny stocks)
   - 90-day log-price regression: slope > 0 AND R² ≥ 0.2

   Rank by slope (steepest trend wins). Take top 20%.

4. **Pyramid**: Existing positions that are still in the top 20% get 50% of cash distributed equally among them. No position can exceed 30% of portfolio.

5. **Fill empty slots**: If slots remain (< 10), batch-buy from top candidates (skipping held stocks + sector cap). Cash is divided equally by candidate count.

6. **Snapshot**: Log portfolio state.

## Parameters

| Parameter            | Value                               |
| -------------------- | ----------------------------------- |
| Max positions        | 10                                  |
| EMA short / long     | 20 / 40                             |
| Regression window    | 90 days                             |
| Min R²               | 0.2                                 |
| Min price            | 10 SEK                              |
| Top percentile       | 20%                                 |
| Pyramid budget       | 50% of cash                         |
| Max position weight  | 30%                                 |
| Sector cap           | Max 1 Hälsovård                     |
| Crash exit threshold | >10% portfolio impact in single day |

## Capital Flow

- Start: 20,000 SEK
- Monthly: +5,000 SEK
- Total over 8 years: 520,000 SEK contributed
- Result: 952,015 SEK (+44% alpha vs OMXSPI DCA)

## Design Decisions

- **Monthly EMA exits (not daily)**: Daily EMA checking causes whipsaw — stocks oscillate around EMA40 in choppy markets, triggering constant sell-rebuy cycles. Monthly checking gives positions time to resolve, acting as a noise filter.

- **Daily slot filling**: Prevents cash drag between rebalances. When positions get EMA-exited at month-end, new capital deploys the next day rather than sitting idle for a month.

- **Crash exit**: Only fires on extreme concentrated-position blowups (a 40% weight stock dropping 25% in a day). Triggered once in 8 years. A trailing stop was tested and destroyed returns (-18% alpha) because correlated crashes stop all positions simultaneously.

- **Batch position sizing**: Cash is divided by the number of actual candidates available, not total open slots. This ensures full capital deployment when few candidates qualify (bear markets).

- **Survivorship filter**: Only trades stocks listed before the backtest start date. Removes ~75 stocks that IPO'd after 2018, reducing alpha by ~20% but making results more honest.
