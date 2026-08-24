# Quant Strategy Curriculum

A systematic path from academic foundations → measured signals → paper-tradeable strategy.  
Built on the knowledge in `quant-foundations.md` and the data already in your database.

---

## Phase 0: What You Already Have

### Your Data Advantage (Swedish Universe via Börsdata)

**Price data**: Daily OHLCV for all Swedish instruments. Enough for momentum, volatility, beta.

**Annual/R12 KPIs** (mapped to paper concepts):

| Paper Concept                | Your KPI (Börsdata)               |   kpiId    | Notes                             |
| ---------------------------- | --------------------------------- | :--------: | --------------------------------- |
| EBIT/EV                      | EBIT/EV                           |     17     | Alberg & Lipton's primary factor  |
| Book-to-market (BE/ME)       | 1/P/B = B/P                       | 4 (invert) | Fama & French key variable        |
| Gross Profit / Assets (GPOA) | Bruttoresultat / TotalaTillgangar |  135, 57   | QMJ profitability #1              |
| ROE                          | ROE                               |     33     | QMJ profitability                 |
| ROA                          | ROA                               |     34     | QMJ profitability                 |
| Operating margin             | Rörelsemarginal                   |     29     | QMJ profitability proxy           |
| Gross margin                 | Bruttomarginal                    |     28     | QMJ profitability                 |
| FCF margin                   | FCF Marginal                      |     31     | QMJ profitability (cash flow)     |
| Revenue growth               | Omsättningstillväxt               |     94     | QMJ growth                        |
| Earnings growth              | Vinsttillväxt                     |     97     | QMJ growth                        |
| EBIT growth                  | EBIT Tillväxt                     |     96     | QMJ growth                        |
| Equity growth                | EgetKapitalTillväxt               |     99     | QMJ growth (asset growth penalty) |
| Leverage (debt/assets)       | Skuldsättningsgrad                |     40     | QMJ safety (negative)             |
| Net debt / EBITDA            | Nettoskuld/EBITDA                 |     42     | QMJ safety                        |
| Soliditet (equity ratio)     | Soliditet                         |     39     | QMJ safety                        |
| EV/EBIT                      | EV/EBIT                           |     10     | Value factor                      |
| P/E                          | P/E                               |     2      | Wang et al.                       |
| Market cap (size)            | BörsVärde                         |     50     | Fama & French size                |
| Dividend yield               | Direktavkastning                  |     1      | Payout / income                   |
| Payout ratio                 | Utdelningsandel                   |     20     | QMJ payout                        |
| FCF/share                    | FCF/Aktie                         |     23     | Cash generation                   |
| P/FCF                        | P/FCF                             |     76     | Alternative value                 |

**Quarterly reports**: Revenue, operating income, EPS, total equity, total assets, net debt, FCF — per quarter. This is what Alberg & Lipton's approach needs for time-series prediction.

### What Vindros Dynamic Gives You

Keep it running as your **baseline to beat**. Its signal (EMA regression slope + filters) is one signal among many. Now you'll measure it properly.

---

## Phase 1: Learn to Measure a Signal (IC)

**Goal**: Before building ANY strategy, learn to compute the ONE number that matters: Information Coefficient.

### What IC Is

IC = Spearman rank correlation between your signal (computed at time t) and subsequent return (measured from t to t+holding_period).

$$IC = \text{corr}_{\text{Spearman}}(\text{signal rank}_t, \text{return rank}_{t \to t+h})$$

### How to Compute It

For a given month t:

1. Compute signal value for every stock in the universe (e.g., EBIT/EV at that year)
2. Rank all stocks by signal (1 = highest EBIT/EV, N = lowest)
3. Measure forward return for each stock (e.g., next 3 months, 6 months, 12 months)
4. Rank all stocks by realized return
5. Compute Spearman correlation between signal rank and return rank
6. That's IC for one month. Average across all months for the full-sample IC.

### What Good Looks Like

|    IC     | Interpretation                          | Source         |
| :-------: | --------------------------------------- | -------------- |
|  < 0.02   | Noise. No signal.                       | —              |
| 0.03–0.05 | Weak but real. Needs high breadth.      | Grinold & Kahn |
| 0.05–0.10 | Good. Most quant signals live here.     | Grinold & Kahn |
| 0.10–0.15 | Strong. Suspicious if on single market. | Bailey et al.  |
|  > 0.15   | Probably overfit or look-ahead bias.    | Bailey et al.  |

### Your First Exercise

Build a script that:

1. For each year Y from 2010 to 2024:
   - Pull EBIT/EV (kpiId 17, reportType "year", priceType "mean") for all instruments with data in year Y
   - Pull subsequent 12-month return from StockPrice (July Y to June Y+1, mimicking Fama-French timing)
   - Compute Spearman rank correlation
2. Report: IC per year, average IC, t-statistic of average IC

**This is the foundational skill.** Everything else builds on this.

---

## Phase 2: Build Your Signal Library

Once you can measure IC, systematically test every signal your data supports.

### Value Signals (from Fama & French, Alberg & Lipton)

| Signal                | Construction                         | Expected sign              |
| --------------------- | ------------------------------------ | -------------------------- |
| Book/Market           | EgetKapital / BörsVärde (invert P/B) | Higher B/M → higher return |
| EBIT/EV               | kpiId 17 directly                    | Higher → higher return     |
| E/EV (earnings yield) | kpiId 16                             | Higher → higher return     |
| FCF/EV                | FrittKassaflöde / EV                 | Higher → higher return     |
| Dividend yield        | kpiId 1                              | Higher → higher return     |

### Profitability Signals (from QMJ)

| Signal                | Construction                      | Expected sign          |
| --------------------- | --------------------------------- | ---------------------- |
| Gross profit / assets | Bruttoresultat / TotalaTillgångar | Higher → higher return |
| ROE                   | kpiId 33                          | Higher → higher return |
| ROA                   | kpiId 34                          | Higher → higher return |
| Operating margin      | kpiId 29                          | Higher → higher return |
| FCF margin            | kpiId 31                          | Higher → higher return |

### Growth Signals (from QMJ)

| Signal                | Construction                          | Expected sign          |
| --------------------- | ------------------------------------- | ---------------------- |
| Revenue growth (5yr)  | Omsättningstillväxt averaged over 5yr | Higher → higher return |
| EBIT growth (5yr)     | kpiId 96 averaged                     | Higher → higher return |
| Earnings growth (5yr) | kpiId 97 averaged                     | Higher → higher return |

### Safety Signals (from QMJ)

| Signal                   | Construction                          | Expected sign              |
| ------------------------ | ------------------------------------- | -------------------------- |
| Low leverage             | −Skuldsättningsgrad (kpiId 40)        | Lower debt → higher return |
| Soliditet (equity ratio) | kpiId 39                              | Higher → higher return     |
| Low net debt/EBITDA      | −(kpiId 42)                           | Lower → higher return      |
| Low beta                 | −(computed from StockPrice vs OMXSPI) | Lower β → higher return    |
| Low earnings volatility  | −std(ROE over 5 years)                | Lower → higher return      |

### Momentum (price-based)

| Signal              | Construction                              | Expected sign          |
| ------------------- | ----------------------------------------- | ---------------------- |
| 12-1 month momentum | Return from t-12 to t-1 (skip last month) | Higher → higher return |
| 6-1 month momentum  | Return from t-6 to t-1                    | Higher → higher return |

### Composite Signals (from QMJ)

| Signal              | Construction                                                     |
| ------------------- | ---------------------------------------------------------------- |
| Profitability score | Average z-score of: GPOA, ROE, ROA, op. margin, FCF margin       |
| Growth score        | Average z-score of: rev growth, EBIT growth, earnings growth     |
| Safety score        | Average z-score of: −leverage, soliditet, −netdebt/EBITDA, −beta |
| **Quality**         | Average of (Profitability + Growth + Safety)                     |

### For EACH Signal, Record:

| Metric                         | What it tells you                                    |
| ------------------------------ | ---------------------------------------------------- |
| IC (avg, t-stat)               | Does it predict returns?                             |
| IC by year                     | Is it stable or regime-dependent?                    |
| Turnover                       | How many stocks change rank each month? (affects TC) |
| Correlation with other signals | Independence → breadth                               |

---

## Phase 3: Understand the Signal-to-Strategy Pipeline

Once you have measured ICs, you choose signals and build a portfolio. The path:

```
Raw KPI data
    ↓
Signal computation (monthly, for all stocks)
    ↓
Cross-sectional ranking (z-score or percentile)
    ↓
Composite score (if combining signals)
    ↓
Portfolio selection (top N stocks by score)
    ↓
Position sizing (equal weight or signal-weighted)
    ↓
Rebalance schedule (monthly or quarterly)
    ↓
Execution (paper trade → live)
```

### Key Decisions at Each Stage

**Signal computation**: Use `reportType: "r12"` for rolling 12-month data (more current than annual). For Fama-French timing: fiscal year t−1 data → portfolio July t to June t+1.

**Ranking**: Convert to z-scores (subtract cross-sectional mean, divide by std). This standardizes all signals to comparable scales. QMJ does this.

**Composite**: Simple average of z-scores. DO NOT optimize weights. (Optimized weights = overfitting per Bailey et al.)

**Portfolio selection**: Start with top 15 stocks (matches your baseline breadth). Later test 10, 20, 30.

**Rebalance**: Monthly (standard). Later test quarterly.

---

## Phase 4: Expected Return Framework (Connecting Papers)

### The Grinold & Kahn Prediction

If you measure IC=0.06 on Swedish stocks with BR=180 (15 stocks × 12 months):

$$IR = IC \times \sqrt{BR} = 0.06 \times \sqrt{180} = 0.06 \times 13.4 = 0.81$$

An IR of 0.81 with tracking error of ~15% (typical for Swedish small-cap) = **12% annual alpha**. That's realistic and matches what the literature finds for value/quality factors.

### The Bailey et al. Constraint

You have ~15 years of Swedish data (2010–2025). With MinBTL:

- If you test N=10 signals → expected max SR from noise ≈ 1.8. You need at least 2·ln(10)/1.8² ≈ 1.4 years. Safe.
- If you test N=100 → expected max SR ≈ 2.8. You need 2·ln(100)/2.8² ≈ 1.2 years. Still safe with 15 years.
- **BUT**: If you then optimize portfolio construction (slots, weights, filters, rebalance timing) you multiply trials enormously. Keep construction FIXED and SIMPLE.

### The QMJ Prediction for Sweden

QMJ earned positive alpha in 23/24 countries including Sweden (IR=0.53, Table 16 in the paper). Your database has all the inputs to replicate this.

---

## Phase 5: Paper Trading Setup

### What You Need

1. **Signal computation script** (runs monthly): Compute your chosen signal(s) for all active instruments. Output: ranked list with scores.

2. **Portfolio construction**: Take top N stocks. Equal weight.

3. **Tracking**: Record portfolio composition at each rebalance. Compare to OMXSPI.

4. **Measurement**: After 3-6 months, compute realized IC. Does the signal work live?

### Suggested First Paper Portfolio

Based on the literature, the highest-probability signal for Swedish stocks:

**Composite Quality + Value (QARP):**

- Profitability z-score: avg(GPOA_z, ROE_z, op_margin_z, FCF_margin_z)
- Safety z-score: avg(soliditet_z, −netdebt_EBITDA_z)
- Value z-score: avg(EBIT_EV_z, B/M_z)
- Final score = avg(Profitability, Safety, Value)
- Buy top 15, equal weight, monthly rebalance

This combines QMJ + HML in spirit — what Asness calls QARP (Quality at a Reasonable Price). Expected IR ≈ 0.7–1.0 based on the global evidence.

---

## Phase 6: Advanced (After You Have Live Results)

### Fundamentals Prediction (Alberg & Lipton)

Once you trust your factor signals, enhance them:

- Use 5 years of quarterly reports to predict next-year EBIT
- Replace current EBIT/EV with predicted-future EBIT / current EV
- This should add 2-3% CAR if the prediction has any skill

### Time the Price of Quality (QMJ Section 6)

Compute monthly: cross-sectional regression coefficient of log(P/B) on quality score. When this is LOW (quality is cheap), increase quality exposure. When HIGH, reduce.

### Multi-Market (QuantNet)

If you add Nordic data (Denmark, Finland, Norway), you can:

- Test signal IC across 4 markets (replication = anti-overfitting)
- Transfer learning: train fundamentals prediction on all 4 markets

---

## Learning Order (What to Build Next)

| Step | What                           | Why                           | Script to Build        |
| :--: | ------------------------------ | ----------------------------- | ---------------------- |
|  1   | IC measurement for EBIT/EV     | Foundational skill            | `scripts/measureIC.ts` |
|  2   | IC for 5 value signals         | Compare signals               | Extend above           |
|  3   | IC for 5 profitability signals | QMJ replication               | Extend above           |
|  4   | Composite quality score IC     | Does combining help?          | New computation        |
|  5   | Signal correlation matrix      | Which are independent?        | Analysis script        |
|  6   | Paper portfolio backtest       | Does IC translate to returns? | Simple backtester      |
|  7   | Live paper trade               | Start tracking                | Monthly cron/manual    |

---

## Key Concepts to Internalize

### Reading Financial Data

**P/E = 15** means: You pay 15 SEK for every 1 SEK of annual earnings. Lower = "cheaper."

**EBIT/EV = 0.12** means: The company's operating earnings are 12% of its total value (equity + debt). Higher = "cheaper" and better. This is the _inverse_ of EV/EBIT. Prefer EBIT/EV because higher = better (consistent direction for ranking).

**ROE = 20%** means: The company generates 20 öre profit per 1 SEK of book equity. Measures how efficiently management uses shareholder capital. Higher = more profitable.

**Soliditet = 45%** means: 45% of assets are financed by equity (the rest is debt). Higher = safer. Swedish convention — internationally this is the "equity ratio."

**Skuldsättningsgrad = 1.2** means: Total debt is 1.2× equity. Higher = more leveraged = riskier. Swedish "debt-to-equity ratio."

**Bruttomarginal = 55%** means: After subtracting cost of goods, 55% of revenue remains. Higher = stronger pricing power. This is gross profit / revenue.

**Rörelsemarginal = 18%** means: After ALL operating costs, 18% of revenue remains as operating profit (EBIT/Revenue). The single best measure of operational efficiency.

### The Z-Score Transformation

For any signal x across N stocks at time t:

1. Compute rank: rank(x_i) for all i
2. Standardize: z_i = (rank_i − mean_rank) / std_rank

This ensures:

- All signals are on the same scale (comparable)
- Outliers are neutralized (rank 1 vs rank 2, regardless of absolute gap)
- You can average z-scores across different signals

### Why Annual Data with R12 Rolling

- `reportType: "year"` = fiscal year end. Stale for 6-11 months depending on fiscal year end.
- `reportType: "r12"` = rolling 12 months (trailing sum). Updated more frequently. Prefer this for live signals.
- `reportType: "quarter"` = single quarter. Noisy (seasonal effects). Use for growth computations.

### Survivorship Bias Warning

Your Börsdata universe includes only currently listed companies (or recently delisted). Companies that went bankrupt in 2012 may not have price history. This biases backtests upward. Acknowledge this — it affects all signals equally, so relative comparisons are still valid, but absolute return estimates should be discounted ~2-3%/year.

---

## Anti-Patterns (What NOT to Do)

1. **Don't optimize portfolio construction.** Fixed N=15, equal weight, monthly rebalance. This is NOT a free parameter.

2. **Don't filter the universe based on the signal.** "Only stocks with positive earnings" is already a bet on profitability. Either include all stocks or justify the filter with theory BEFORE looking at data.

3. **Don't combine more than 3-4 signals without measuring correlation.** Redundant signals add noise without breadth.

4. **Don't backtest then adjust.** Measure IC → pick signal → build portfolio → paper trade. One direction. No iteration on the same data.

5. **Don't interpret IC < 0.03 as "almost significant."** It's noise. Move on.

6. **Don't use quarterly data without annualizing.** Q4 always looks different from Q1 for seasonal businesses. Use r12 rolling to smooth this.

---

## Success Criteria

After Phase 1-3 (measuring IC on your Swedish data):

- You should have 3-5 signals with IC > 0.04 and t-stat > 2.0
- You should know which signals are correlated (redundant) and which are independent
- You should have one composite signal ready for paper trading

After 6 months of paper trading:

- Realized IC should be within range of historical IC
- Portfolio should outperform OMXSPI by more than transaction costs
- You should be able to state: "My signal has IC of X, my strategy has BR of Y, my expected IR is Z"

That's when you have a **real** quant strategy — not a backtest, but a measured edge with live confirmation.
