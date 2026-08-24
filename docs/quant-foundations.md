# Quantitative Foundations

Distilled knowledge from academic papers and books. Assumed as ground truth for strategy development.

---

## Grinold & Kahn — The Fundamental Law of Active Management (1989)

### Core Equation

$$IR = IC \times \sqrt{BR}$$

- **IR** (Information Ratio): Annualized excess return divided by tracking error (annualized standard deviation of excess return). Measures risk-adjusted alpha generation.
- **IC** (Information Coefficient): Correlation between predicted and realized returns. Ranges from -1 to 1. A value of 0.05–0.10 is considered good for quantitative strategies.
- **BR** (Breadth): Number of independent forecasting opportunities per year.

### Extended Form (with Transfer Coefficient)

$$IR = TC \times IC \times \sqrt{BR}$$

- **TC** (Transfer Coefficient): Fraction of signal that survives into the actual portfolio after constraints (position limits, turnover limits, transaction costs, liquidity). TC=1 means zero friction. Realistic TC ≈ 0.3–0.7.

### Principles

1. **Signal quality vs. opportunity count**: A weak signal (low IC) applied across many independent bets (high BR) can produce a higher IR than a strong signal applied rarely.

2. **Independence matters**: BR counts _independent_ bets. Correlated positions reduce effective breadth. 15 Nordic bank stocks rebalanced together ≠ 15 independent bets.

3. **Square root scaling**: Doubling breadth gives √2 ≈ 1.41× improvement in IR, not 2×. You cannot brute-force a bad signal with more bets.

4. **IC is measurable**: Rank correlation (Spearman) between your signal score and subsequent return over the holding period. Should be measured out-of-sample.

5. **Concentration demands signal strength**: With BR=36 (3 positions × 12 months), you need IC ≈ 0.17 to reach IR=1.0. With BR=180 (15 positions × 12 months), you only need IC ≈ 0.075.

6. **Constraints destroy alpha**: Every real-world constraint (max position size, sector limits, turnover caps, liquidity floors) reduces TC and therefore realized IR. The gap between theoretical and realized IR is entirely explained by TC < 1.

7. **Optimal portfolio size**: Given IC and available universe, there exists an optimal number of positions that maximizes IR. Too few = low breadth. Too many = dilution of signal into noise names.

### Definitions & Measurement

| Metric | Formula                                                   | Interpretation                    |
| ------ | --------------------------------------------------------- | --------------------------------- |
| IR     | $\frac{\bar{r}_p - \bar{r}_b}{\sigma(r_p - r_b)}$         | >0.5 is good, >1.0 is exceptional |
| IC     | $\text{corr}(\text{forecast rank}, \text{realized rank})$ | >0.05 is meaningful               |
| BR     | # independent bets / year                                 | Depends on correlation structure  |
| TC     | $\frac{IR_{\text{realized}}}{IC \times \sqrt{BR}}$        | 1.0 = frictionless                |

### Common Misconceptions

- BR is NOT simply (# stocks × # rebalance periods). Overlapping holding periods, correlated signals, and correlated assets all reduce effective BR.
- IC is NOT hit rate. A strategy can have 40% hit rate but positive IC if winners are larger than losers (asymmetric payoffs).
- High IR does not imply high absolute return. IR=2.0 with 3% tracking error = 6% alpha. IR=0.5 with 20% tracking error = 10% alpha.

---

## Bailey, Borwein, López de Prado & Zhu — Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance (2014)

_Published in Notices of the American Mathematical Society, Vol. 61, No. 5_

### Central Thesis

Most published backtests are overfit. When you try enough strategy variations on the same dataset, you _will_ find one that looks good — by pure chance. The probability that a backtest-optimal strategy has zero or **negative** out-of-sample performance is quantifiable and alarmingly high. Worse: when financial series have memory (which they do), overfitting is actively **detrimental** — selecting the best in-sample strategy produces negative out-of-sample results.

### Core Result: Expected Maximum Sharpe Ratio (Proposition 1)

Given N independent strategy configurations tested on the same data, each with true Sharpe ratio of zero, the expected maximum Sharpe ratio observed in-sample is:

$$E[\max_N] \approx (1 - \gamma)Z^{-1}\left[1 - \frac{1}{N}\right] + \gamma Z^{-1}\left[1 - \frac{1}{Ne^{-1}}\right]$$

where γ ≈ 0.5772 (Euler-Mascheroni constant) and Z⁻¹ is the inverse Standard Normal CDF.

**Upper bound:** $E[\max_N] \leq \sqrt{2 \ln N}$

**Concrete example from the paper:** With only N=10 trials, the expected maximum Sharpe ratio IS is **1.57** despite all strategies having true SR = 0.

### Minimum Backtest Length (Theorem 2)

The minimum number of years of data needed to avoid selecting a skill-less strategy with IS Sharpe ratio E[max_N] among N trials:

$$MinBTL < \frac{2\ln[N]}{E[\max_N]^2} \text{ years}$$

**Key example from Figure 2:** If only 5 years of data are available, no more than **45 independent model configurations** should be tried — beyond that, you are almost guaranteed to produce an annualized SR of 1.0 IS from a strategy with expected SR of 0 OOS.

### Compensation Effects: WHY Overfitting is Worse Than Useless

This is the paper's most important and counterintuitive result. Two cases:

**Case 1: No memory (IID returns)**

- Selecting the best IS strategy has NO bearing on OOS performance
- OOS performance remains around the true mean (zero for a random walk)
- Overfitting is "neutral" — you get nothing, but you don't lose

**Case 2: With memory (mean-reversion, serial correlation, global constraints)**

- Financial series almost always have memory (mean-reversion, momentum decay, crowding)
- **Proposition 3:** Under a global constraint, $SR^A_{IS} > SR^B_{IS} \implies SR^A_{OOS} < SR^B_{OOS}$
- **Proposition 5:** Under first-order serial correlation, the same anti-correlation holds
- **Meaning:** The more you optimize in-sample, the WORSE the out-of-sample performance
- A strongly negative linear relationship exists between IS and OOS Sharpe ratios (statistically significant, p ≈ 0)

**Implication:** The standard warning "past performance is not an indicator of future results" is **too optimistic.** When advisers don't control for overfitting, good backtested performance is an indicator of **negative** future results.

### The Half-Life of Mean-Reversion (Proposition 4)

For a first-order autoregressive process with coefficient φ:

$$\tau_{half} = -\frac{\ln 2}{\ln \phi}$$

Example: φ = 0.995 → half-life ≈ 138 observations. This is enough serial correlation to make overfitting actively destructive.

### Practical Example (Example 6 from the paper)

A seasonal trading strategy with 4 parameters:

- Entry day: {1,...,22}
- Holding period: {1,...,20}
- Stop loss: {0,...,10}
- Side: {-1, 1}

Total combinations: **8,800 trials.**

Applied to 1,000 daily prices from a **pure random walk** (no signal):

- Optimal configuration found: Entry day=11, Holding=4, Stop loss=-1, Side=1
- Annualized Sharpe ratio: **1.27**
- PSR-stat: 2.83 (implies <1% probability that true SR is below 0)

**A completely fictitious strategy passes all standard significance tests because 8,800 trials were hidden.**

### Model Complexity and Overfitting

A strategy with just 7 binary parameters → N = 2⁷ = 128 trials → expected maximum SR > 2.6 from pure noise. You don't need complex models to overfit — a "relatively simple" strategy with a handful of parameters is sufficient.

The key fact investors miss:

> _"A researcher that does not report the number of trials N used to identify the selected backtest configuration makes it impossible to assess the risk of overfitting."_

### Practical Rules

1. **Record every trial.** If you tried 50 parameter sets and report only the best, you have N=50. Without reporting N, overfitting risk is unknowable.

2. **Fewer configurations = less overfitting risk.** 7 binary parameters = 128 trials. 5 parameters × 10 values = 100,000 trials. Even "simple" models accumulate trials fast.

3. **The 5-year / 45-trial rule of thumb.** With 5 years of daily data, no more than ~45 independent configurations should be tested before overfitting dominates.

4. **Compensation effects make it worse than neutral.** In real markets with serial dependence, the "optimal" backtest is expected to produce **negative** OOS performance, not just zero.

5. **Standard significance tests fail.** AIC, p-values, PSR — none account for the number of unreported trials. A strategy that "passes" all tests at 95% confidence will be found after only 20 trials by chance.

6. **Sharpe ratio is especially exploitable.** Being a single scalar, it's trivial to optimize against. Strategies can have identical Sharpes with wildly different return distributions.

7. **Hold-out (train/test split) doesn't solve the problem.** If the researcher had access to both samples during development, the hold-out is compromised. "Model sequestration" (announcing the model before observing OOS data) is the only robust alternative.

### Symptoms of Backtest Overfitting

- Strategy performs well only in specific regimes that dominated the backtest period
- Small parameter changes cause large performance changes (fragile)
- Many parameters relative to data points
- Performance clusters around a few lucky trades
- The number of trials N is not reported
- Ex-post narrative constructed to justify ex-ante selection ("the posterior gives rise to a prior")

### Defenses

1. **Minimize free parameters.** Each parameter is a dimension for overfitting.
2. **Report N honestly.** Apply MinBTL calculation.
3. **Economic plausibility BEFORE testing.** If you can't explain _why_ before you look at results, any finding is suspect.
4. **Assume compensation effects.** Treat IS optimization as actively harmful until proven otherwise.
5. **Parsimony.** Von Neumann: "With four parameters I can fit an elephant, and with five I can make him wiggle his trunk."
6. **Cross-market validation.** A real pattern works across related markets. An overfit doesn't.

---

## Harvey & Liu — Lucky Factors (2021, Journal of Financial Economics)

_Previously circulated as "How many factors?" and "Incremental factors."_

### Central Thesis

Given hundreds of proposed factors, some will appear significant by pure luck (test multiplicity). This paper proposes a bootstrap-based stepwise method to identify which factors are genuinely useful for explaining the cross-section of expected returns, while controlling for multiple testing. The method operates on **individual stocks** (not sorted portfolios) and uses **panel regressions** — and finds that very few factors survive.

### The Method

**1. Panel Regression Framework**

For N stocks and K factors:
$$R_{it} - R_{ft} = a_i + \sum_{j=1}^{K} b_{ij} f_{jt} + \epsilon_{it}$$

A factor is "useful" if adding it to the model significantly reduces the cross-section of regression intercepts (alphas).

**2. Imposing the Null Hypothesis**

To test whether factor f₂ has incremental value beyond existing factor f₁:

- Project f₂ onto f₁: $f_{2t} = \delta_0 + \delta_1 f_{1t} + \varepsilon_t$
- Define pseudo-factor: $f^*_{2t} = f_{2t} - \delta_0$ (subtract the intercept)
- This adjusted factor retains all time series properties (correlation, volatility, non-normality) but has **zero incremental cross-sectional explanatory power**
- Bootstrap (resample time periods) to generate the distribution of intercept reductions under this null

**3. Multiple Testing Control**

For each bootstrap sample:

- Compute the test statistic for every candidate factor
- Record the **minimum** (best improvement) across all candidates
- The distribution of this minimum statistic controls for multiple testing (White, 2000 reality bootstrap)
- Compare actual minimum to this bootstrapped distribution for p-values

**4. Test Statistics**

$$SI^m_{ew} = \frac{\frac{1}{N}\sum_{i=1}^{N}(|a^+_i| - |a_i|)/s_i}{\frac{1}{N}\sum_{i=1}^{N}|a_i|/s_i}$$

Measures the percentage reduction in scaled absolute intercepts when adding a factor. Negative = improvement. Scaling by standard error accounts for heterogeneous volatilities (crucial for individual stocks).

### Key Empirical Results (14 factors, individual US stocks, 1968–2012)

**Equal-weighted test (all stocks matter equally):**

| Step | Factor added                  | Intercept reduction | Multiple-test p-value |
| ---- | ----------------------------- | :-----------------: | :-------------------: |
| 1    | **mkt** (market)              |       -20.6%        |         0.002         |
| 2    | **smb** (size)                |        -6.2%        |         0.039         |
| 3    | **hml** (value)               |        -4.0%        |         0.018         |
| 4    | No further factor significant |          —          |         0.932         |

**Value-weighted test (big stocks matter more):**

| Step | Factor added                    | Intercept reduction | Multiple-test p-value |
| ---- | ------------------------------- | :-----------------: | :-------------------: |
| 1    | **mkt** (market)                |       -44.4%        |        <0.001         |
| 2    | **qmj** (quality/profitability) |       -14.9%        |         0.004         |
| 3    | No further factor significant   |          —          |         0.637         |

**The market factor is by far the single most important factor.** It alone explains 44% of value-weighted pricing errors. The next factor is second-order.

### Why the Market Factor Dominates (Contrary to Much Literature)

The market factor is often "knocked out" in Fama-MacBeth cross-sectional tests. Harvey & Liu show this is an artifact of the testing method:

- **Panel regressions** allow asset-specific intercepts that absorb idiosyncratic variation unrelated to the factor. This reveals the market factor's true explanatory power.
- **Cross-sectional regressions** have a single intercept and are more susceptible to omitted variable bias and extreme observations.

Simple example: Stock A has 10% excess return, beta=1. Stock B has 10% excess return, beta=2. Market premium=5%. Cross-sectional regression: zero slope → market factor rejected. Panel regression: correctly identifies that B's return is fully explained by market exposure, while A retains a 5% alpha. The market factor IS useful — it just doesn't explain everything.

### Why Individual Stocks > Sorted Portfolios

1. **Portfolio sorts introduce bias.** Sorting by size and book-to-market mechanically favors factors constructed from those same characteristics.
2. **No loss in power.** Simulation shows bootstrap tests on individual stocks have power ≥ portfolio-based tests (average ~83% power with 480 months of data).
3. **Avoids arbitrary choices.** Different portfolio sorts → different factors identified. Individual stocks are neutral.
4. **Panel regression handles the noise.** Scaling intercepts by standard errors down-weights noisy (small) stocks without discarding them.

### The Rapid Decline in Factor Importance

The economic significance drops dramatically after the first factor:

- Market: reduces baseline intercepts by 44.4% (value-weighted)
- qmj: reduces remaining intercepts by 14.9% → net 8.3% of original baseline
- Next best (bab): 2.6% reduction → net 1.2% of original baseline

**After 2-3 factors, the remaining candidates are indistinguishable from luck.**

### Factor Clusters

Many candidate factors are just repackaged versions of each other:

- **Value group**: hml, cma (investment), ia — correlations 0.69–0.90
- **Profitability group**: rmw, roe, qmj — correlations 0.68–0.76

Selecting one from a cluster makes the others redundant.

### The Berkshire Hathaway Problem

Fama & French (2015) include factors based on spanning tests (high alpha when regressed on existing factors). But Berkshire Hathaway stock has alpha of 10.6%/year (t=12.3) against FF5 — yet it obviously cannot explain the cross-section of returns. **High Sharpe ratio ≠ useful risk factor.** Methods that select factors by Sharpe ratio or spanning alpha (like Barillas & Shanken, 2017) are susceptible to this.

### Practical Implications

1. **Very few factors matter.** After multiple testing correction on individual stocks, only 2-3 factors survive (market + size/value or market + profitability depending on weighting).

2. **The market factor is real.** Despite decades of academic debate, it dominates when tested properly (panel regression, individual stocks, bootstrap for multiple testing).

3. **Testing method matters as much as multiple testing correction.** Panel vs. cross-sectional regression can flip conclusions about which factors survive. The testing framework is not neutral.

4. **Portfolio-based tests are biased.** Factors discovered on size/BM-sorted portfolios look good on those same portfolios by construction. Individual stocks provide a cleaner test.

5. **Factor significance decays rapidly with each addition.** The marginal value of the 4th or 5th factor is essentially zero after proper correction.

6. **Profitability is real but recent.** qmj/rmw survive value-weighted tests, but they were only discovered in 2015. Their entire pre-publication history is a backtest — caveat applies.

7. **Report the number of candidates tested.** The multiple-testing p-value depends on how many factors were in the candidate set. With 56 candidates, the threshold is stricter than with 14.

### Robustness

Results hold with:

- 56 factors (extended set from Ehsani & Linnainmaa, 2021)
- Block bootstrapping (time-series dependence)
- Trimming smallest 10% of stocks
- Time-varying factor loadings (pooled regression with characteristic interactions)

### Relation to Other Papers in This Document

- **Bailey et al.**: Lucky Factors operationalizes the "how many trials" problem specifically for factor research. The bootstrap controls for N trials, analogous to MinBTL.
- **Grinold & Kahn**: The market factor's dominance is consistent with it being the highest-breadth factor (all stocks load on it).
- **López de Prado**: The bootstrap null-enforcement is conceptually similar to CPCV — both aim to generate distributions under properly specified nulls.

---

## Fama & French — The Cross-Section of Expected Stock Returns (1992, Journal of Finance)

### Central Thesis

Market beta (β) does NOT explain cross-sectional variation in average stock returns. Two easily measured variables — **size** (market equity, ME) and **book-to-market equity** (BE/ME) — together capture the cross-sectional variation associated with β, size, leverage, E/P, and book-to-market equity. This paper effectively killed CAPM as an empirical model and launched the Fama-French factor era.

### The Death of Beta

**The apparent β-return relation is a size effect in disguise:**

When portfolios are formed on size alone:

- β and size are almost perfectly correlated (−0.988)
- There appears to be a positive β-return relation (as CAPM predicts)
- But the test cannot separate size from β effects

When portfolios are formed on size THEN β (100 portfolios: 10 size × 10 β):

- Wide range of β within each size decile (e.g., 1.05 to 1.79 in smallest decile)
- β variation is independent of size (average ln(ME) is similar across β groups within a size decile)
- **Average returns show NO tendency to increase with β within size deciles**
- Average returns DO decrease with size within β groups

**Fama-MacBeth regression results (1963–1990):**

| Regression              | β slope | t-stat | ln(ME) slope | t-stat |
| ----------------------- | :-----: | :----: | :----------: | :----: |
| Returns on β alone      |  0.15%  |  0.46  |      —       |   —    |
| Returns on ln(ME) alone |    —    |   —    |    −0.15%    | −2.58  |
| Returns on β + ln(ME)   | −0.37%  | −1.21  |    −0.17%    | −3.41  |

β is economically and statistically zero when used alone. When combined with size, β turns negative. Size is robust regardless.

**Historical context:** The positive β-return relation found by Black, Jensen & Scholes (1972) and Fama & MacBeth (1973) was driven by the 1941–1965 period, specifically 1941–1950. Even in that period, controlling for size eliminates the β effect.

### Size (ME) Effect

- Small stocks earn higher average returns than large stocks
- Spread: 1.64%/month (smallest decile) vs 0.90% (largest) = 0.74%/month difference
- Effect is robust across all subperiods and to inclusion of other variables
- ln(ME) always produces slopes 2+ standard errors from zero in multivariate regressions

### Book-to-Market (BE/ME) Effect

- **Stronger than size.** Average returns rise monotonically from 0.30%/month (lowest BE/ME decile) to 1.83%/month (highest) — a spread of 1.53%/month
- This 1.53% spread is twice the 0.74% size spread
- ln(BE/ME) slope = 0.50% (t = 5.71) in univariate regressions
- Robust in both subperiods: slopes of 0.36 (t = 2.96) for 1963–76 and 0.35 (t = 3.30) for 1977–90
- **NOT a β effect**: post-ranking βs vary little across BE/ME-sorted portfolios (range 1.27–1.36)
- Strong throughout the year (not just a January effect, unlike size)

### The 10×10 Size-BE/ME Matrix

Average monthly returns (%) for portfolios formed on size (rows) then BE/ME (columns):

- Within a size decile, moving from low to high BE/ME adds ~0.99%/month on average
- Within a BE/ME group, moving from small to large size reduces returns by ~0.58%/month
- Both effects are independent and additive

### BE/ME Absorbs Leverage and E/P

**Leverage puzzle solved:**

- Market leverage (A/ME): positive relation with returns (slope 0.50, t = 5.69)
- Book leverage (A/BE): negative relation with returns (slope −0.57, t = −5.34)
- Slopes are opposite in sign but nearly equal in magnitude
- Their difference IS book-to-market: ln(BE/ME) = ln(A/ME) − ln(A/BE)
- **Conclusion:** The leverage effect in returns is entirely captured by BE/ME

**E/P absorbed:**

- U-shaped relation: negative earnings → high returns; among positive E/P, returns increase with E/P
- Adding size kills the negative-E/P effect (those firms are just small)
- Adding size + BE/ME kills the positive-E/P effect (E/P and BE/ME are positively correlated)
- Average E/P slope drops from 4.72 (t = 4.57) to 0.87 (t = 1.23) when size + BE/ME included

### The Parsimonious Model

$$E(R_i) - R_f = b_{\text{size}} \cdot \ln(ME_i) + b_{\text{value}} \cdot \ln(BE/ME_i)$$

Two variables — size and book-to-market — capture everything. β, leverage, and E/P add nothing incremental.

### Methodology

**Data:** NYSE, AMEX, NASDAQ nonfinancial firms, 1963–1990 (CRSP returns × COMPUSTAT accounting data)

**β estimation (innovative two-pass sort):**

1. Sort all NYSE stocks into 10 size deciles (June of year t)
2. Within each size decile, sort into 10 β portfolios using pre-ranking βs (estimated from prior 24–60 months)
3. Calculate equal-weighted post-ranking returns on the 100 portfolios (July t to June t+1)
4. Estimate post-ranking βs using full sample (sum of slopes on current + prior month market return, to adjust for nonsynchronous trading)
5. Assign portfolio β to each stock → use in FM cross-sectional regressions

**Accounting variable timing:** Fiscal year t−1 accounting data matched with returns July t to June t+1 (6-month minimum gap ensures data availability)

### Economic Interpretation

The paper offers two interpretations for why BE/ME predicts returns:

**Rational (risk-based):**

- High BE/ME = market judges firm has poor prospects → higher cost of capital (distress premium)
- BE/ME captures a "relative distress" risk factor (Chan & Chen, 1991)
- Firms with persistently weak earnings have high BE/ME and high expected returns

**Irrational (behavioral):**

- Market overreacts to relative prospects of firms
- High BE/ME results from prices being beaten down too much
- Subsequent high returns reflect correction of overreaction

The paper does NOT resolve which interpretation is correct. It only establishes the empirical fact.

### Relation to Other Papers in This Document

- **Harvey & Liu (2021)**: In their panel regression framework, the market factor IS the dominant factor for individual stocks. Fama & French 1992 uses cross-sectional (FM) regressions which tend to reject the market factor. Harvey & Liu explain this discrepancy: panel regressions allow asset-specific intercepts that absorb omitted factors, while FM regressions have a single intercept and are more susceptible to misspecification.
- **Grinold & Kahn**: Size and BE/ME can be viewed as signals with measurable IC. The 10×10 sort structure is essentially measuring the joint IC of two signals.
- **Bailey et al.**: The sorted portfolio approach is itself a form of multiple testing — different sorts produce different "winning" factors. Fama & French acknowledge this: "different test portfolios lead to different results."

---

## Koshiyama, Firoozye & Treleaven — QuantNet: Transferring Learning Across Systematic Trading Strategies (2020)

### Central Thesis

Current trading strategies treat each market in isolation, failing to capture inter-market dependencies (contagion, global macro). By learning a shared global representation across 58 equity markets simultaneously, you can produce superior market-specific strategies — especially in data-scarce markets where single-market models overfit.

### Architecture

```
Market-specific encoder (LSTM) → Global shared layer ω (linear) → Market-specific decoder (LSTM) → Signal
```

Each market Mᵢ gets its own encoder-decoder pair:

1. **Encoder** (per-market LSTM): Transforms market-specific returns into a latent encoding eᵢ. Captures internal market dynamics (fiscal conditions, development stage, sector composition).

2. **Global layer ω** (shared linear layer): Processes all market encodings through a single bottleneck. Forces encodings to be "globally aware." Critically, a simple linear layer outperforms an LSTM here — the bottleneck enforces information compression.

3. **Decoder** (per-market LSTM): Takes the globally-conditioned representation zᵢ and produces trading signals sᵢ ∈ (-1, 1)ⁿ via tanh activation. The decoder learns a market-specific strategy that is informed by global structure.

### Learning Objective

Directly maximizes annualized Sharpe ratio (not MSE or return prediction):

$$\rho^i_{t,j} = \frac{\mu^i_{t-k:t,j}}{\sigma^i_{t-k:t,j}} \cdot \sqrt{252}$$

Loss averaged over all assets in all sampled markets. This is crucial: MSE minimization is necessary but not sufficient for profitable trading. Sharpe directly optimizes risk-adjusted returns.

### Training Procedure

1. Sample mini-batch of m markets from full set
2. Randomly select time step t
3. Run encoder-decoder forward from t-k to t (truncated backprop horizon)
4. Compute per-asset Sharpe ratios
5. Average loss across assets and markets
6. Backpropagate through time into all parameters (market-specific and global)

The global layer gradient integrates out idiosyncratic market noise:

$$\nabla_\phi L = \sum_{i=1}^{N} \delta^i_t \frac{\partial s^i_t}{\partial d^i_t} \frac{\partial d^i_t}{\partial z^i_t} \frac{\partial \omega}{\partial \phi}(e^i_t)$$

### Key Results (3103 assets, 58 markets, 2000–2019)

| Strategy                                 | Sharpe Ratio | Calmar Ratio |
| ---------------------------------------- | :----------: | :----------: |
| Buy and hold                             |    0.000     |    0.000     |
| Cross-sectional momentum (best baseline) |    0.235     |    0.143     |
| No Transfer LSTM (single-market)         |    0.304     |    0.159     |
| No Transfer Linear                       |    0.307     |    0.169     |
| **QuantNet**                             |  **0.355**   |  **0.241**   |

- **+51% Sharpe** and **+69% Calmar** vs best traditional baseline (CS momentum)
- **+15% Sharpe** and **+41% Calmar** vs No Transfer variant (same architecture without global sharing)
- Statistically significant (Wilcoxon p < 0.01, KS p < 0.01)
- In large regional markets (S&P 500, FTSE 100, KOSPI): 2–10× improvement in SR and CR
- Generated positive, statistically significant alpha vs Fama-French 5 factors

### Emergent Structure

Without receiving geographic information, QuantNet's encoder representations cluster markets by geo-economic similarity:

- C5: Small European (Spain, Netherlands, Belgium, France)
- C6: Developed Europe + Americas (UK, Germany, US, Sweden, Denmark, Canada)
- C2: Developed Asia (Japan, Hong Kong, Korea, Singapore)
- C3: Asia-Pacific emerging (China, India, Australia)

This proves the global layer learns real economic structure, not noise.

### When Transfer Helps Most

1. **Small sample sizes** (6–7 years of data): Largest gains from transfer. Single-market models overfit; global conditioning regularizes.
2. **Large markets** (many assets): Better performance with transfer. More assets = more signal for the decoder to exploit.
3. **Medium sample sizes** (~10 years): Mixed results — some markets showed no transfer benefit. Room for improvement in the global bottleneck design.

### Practical Implications

1. **Markets are not independent.** Treating Swedish equities in isolation throws away information from correlated Nordic/European markets. A model that conditions on global structure should generalize better.

2. **Transfer learning as regularization.** The global bottleneck forces market-specific models to produce representations useful across all markets simultaneously. This prevents overfitting to idiosyncratic market patterns.

3. **Simple bottlenecks > complex ones.** The global layer ω being a linear layer (not an LSTM) means the information compression is the mechanism — not additional modeling capacity.

4. **Sharpe as loss function, not evaluation metric.** Training directly on Sharpe aligns the optimization with the investment objective. MSE-trained models may learn to predict returns accurately but not profitably.

5. **Data scarcity is solvable.** Nordic markets (small by global standards) are exactly where transfer learning provides the largest benefit. Rather than needing 20 years of local data, you can borrow structure from larger markets.

6. **End-to-end > pipeline.** Generating signals directly from returns (no hand-crafted features like RSI, MACD) avoids embedding human assumptions that may be wrong.

7. **Multi-task = anti-overfitting.** Consistent with Bailey et al.: optimizing across many markets simultaneously reduces the effective degrees of freedom for any single market, making overfitting harder.

### Limitations

- Requires Bloomberg-level data access across many markets (not trivially available)
- LSTM architecture may not capture long-range dependencies optimally (transformers not tested)
- Median Sharpe of 0.355 is still modest — this is long-only/short signal, not absolute return
- Validation is last 3 years (~752 days) — single split, no CPCV
- No transaction cost modeling

---

## Wang, Chatpatanasiri & Sattayatham — Stock Trading Using PE Ratio: A Dynamic Bayesian Network Modeling (2017, arXiv)

### Central Thesis

The PE ratio — the most widely used valuation tool by fundamental investors — can be formalized using a Dynamic Bayesian Network (DBN) that separates the **fundamental PE** (constant, latent) from **medium-term mispricing** (Markov chain, latent) and **short-term noise** (Gaussian). The resulting model produces a unified trading strategy that consistently outperforms buy-and-hold.

### The Price Model

Stock price decomposes into three components:

$$P_t = PE^* \times E_t \times (1 + z_t) \times (1 + \varepsilon_t)$$

- $PE^*$ — fundamental PE ratio (constant for a given period, latent/unobservable)
- $E_t$ — annual earnings (observable, sum of last 4 quarterly earnings)
- $z_t$ — medium-term mispricing effect (Markov chain, persists weeks/months)
- $\varepsilon_t$ — short-term noise ($\varepsilon_t \sim \mathcal{N}(0, \sigma^2)$, daily fluctuations)

In log form:
$$y_t = \ln(P_t / E_t) = \ln(PE^*(1 + z_t)) + \varepsilon_t$$

where $y_t$ is the observed log-PE (observable) and the right side contains two latent variables of different types: $PE^*$ is static, $z_t$ is dynamic.

### Behavioral Finance Motivation

Why does price deviate from fundamental value? The paper cites specific behavioral finance evidence:

**Short-term effects** (days):

- Noise trading (DeLong et al.)
- Overreaction to unreliable/unconfirmed information

**Medium-term effects** (weeks/months):

- Reaction to unconfirmed information that takes time to verify
- Overoptimistic analyst predictions that take time to disprove
- Limit of arbitrage prevents immediate correction

Both effects eventually revert (mean reversion), but the medium-term effect $z_t$ persists long enough to be modeled as a Markov chain rather than white noise.

### DBN Structure

Three-layer graphical model:

1. **Top layer**: $PE^*$ (static latent variable, discrete: $PE^* \in \{b_1, ..., b_N\}$)
2. **Middle layer**: $\{z_t\}$ (dynamic latent variable, Markov chain: $z_t \in \{a_1, ..., a_M\}$)
3. **Bottom layer**: $\{y_t\}$ (observed log-PE)

**Parameters** $\theta = \{W, u, v, \sigma^2\}$:

- $W$ = transition matrix for $z_t$ (M×M)
- $u$ = initial distribution of $z_1$
- $v$ = prior distribution over $PE^*$ values
- $\sigma^2$ = short-term noise variance

### Inference

**With known parameters** — Forward-backward algorithm adapted for the two-type latent structure:

Filtering (estimates current state given past observations):
$$A_t = \frac{1}{c_t} \Phi_t \circ (W A_{t-1})$$

Smoothing (estimates any past state given ALL observations):
$$p(z_t, PE^* | y_1^T) = \alpha_{t,mn} \cdot \beta_{t,mn}$$

**With unknown parameters** — EM algorithm with MAP estimation:

- E-step: compute smoothing probabilities
- M-step: maximize $Q(\theta; \theta^{(j)}) + \ln p(\theta)$

Expert knowledge enters through Dirichlet priors on $v$ (beliefs about PE\* range) and $W$ (beliefs about mispricing persistence).

### Trading Strategies

**Strategy 1 — Long-term (compare to $PE^*$):**

- Buy when: observed PE < $PE^*(1 - Tr)$ (undervalued)
- Sell when: observed PE > $PE^*(1 + Tr)$ (overvalued)

**Strategy 2 — Medium-term (compare to $PE^*(1 + z_t)$):**

- Buy when: observed PE < $PE^*(1 + z_t)(1 - Tr)$
- Sell when: observed PE > $PE^*(1 + z_t)(1 + Tr)$
- $z_t$ estimated via filtering (tracks medium-term regime in real-time)

$Tr$ is a threshold parameter (5–20% for long-term, 3–10% for medium-term).

### Experimental Results (10 Thai + 10 US stocks, 2012–2016)

Training: 3 years (2012–2014). Testing: 2 years (2015–2016).

**Individual stock level (160 total simulations):**

| Strategy                     |  Wins  | Draws  | Losses | vs buy-and-hold              |
| ---------------------------- | :----: | :----: | :----: | :--------------------------- |
| Long-term (all thresholds)   |   22   |   44   |   14   | Draws = never triggered sell |
| Medium-term (all thresholds) |   55   |   0    |   25   | More frequent trading        |
| **Total**                    | **77** | **44** | **39** |                              |

**Portfolio level (bootstrap resampling, 15-stock portfolios):**

| Portfolio            |  E[X] range  | P(X ≥ 0) best case |
| -------------------- | :----------: | :----------------: |
| Thai stocks only     | 0.45%–7.46%  |       86.8%        |
| US stocks only       | 1.03%–14.04% |       99.8%        |
| Combined (15 stocks) | 0.77%–8.89%  |       97.9%        |

Where X = our profit% − benchmark profit%. Diversification increases confidence of superiority.

### When the Model Fails

1. **Growth stocks**: Consistently increasing earnings → price rarely falls below PE\* threshold → model buys/sells too early or never trades
2. **Non-recurring earnings**: One-time profits inflate E_t → model thinks stock is undervalued when market correctly ignores the temporary earnings
3. **High commission environments**: Medium-term strategy trades frequently → fees erode edge

### Key Properties

1. **Unified strategy**: Same model/strategy applies to every stock (unlike pattern-discovery ML where each stock gets unique patterns)
2. **Interpretable**: Every component has clear financial meaning (PE\*, medium-term mispricing, short-term noise)
3. **Expert-integrable**: Dirichlet priors naturally encode analyst beliefs about PE\* range and mispricing persistence
4. **Parsimonious**: M < 10 states for z_t → transition matrix W is small → 3 years of data suffices for estimation
5. **Mean-reversion assumption**: The model assumes prices revert to fundamental value — it is explicitly a value investing model

### Relation to Other Papers in This Document

- **Fama & French (1992)**: BE/ME (inverse of PE in spirit) is the strongest cross-sectional predictor. This paper operationalizes a similar insight at the individual-stock level: PE deviations from fundamental are tradeable.
- **Bailey et al.**: The threshold Tr is a free parameter — testing multiple thresholds on the same data is exactly the multiple testing problem. The paper tests 4 thresholds × 2 strategies = 8 trials per stock, which is modest but unreported in significance terms.
- **Harvey & Liu (2021)**: The market factor dominates cross-sectionally; this paper works within a single stock at a time (time-series, not cross-section), so the approaches are complementary rather than competing.

---

## Asness, Frazzini & Pedersen — Quality Minus Junk (2019, Review of Accounting Studies)

### Central Thesis

Quality should be defined as characteristics that investors _should_ be willing to pay a higher price for. Using a dynamic valuation model, they show price-to-book should increase linearly in profitability, growth, and safety. Empirically, high-quality stocks DO have higher prices — but not nearly enough. This puzzlingly modest price-of-quality means high-quality stocks deliver large risk-adjusted returns, while low-quality ("junk") stocks deliver negative risk-adjusted returns. A long/short factor — Quality Minus Junk (QMJ) — earns significant alpha in the US (1957–2016) and across 24 countries, with an information ratio above 1.0.

### The Valuation Model

Starting from Gordon's growth model rewritten as:

$$\frac{P}{B} = \frac{\text{profitability} \times \text{payout-ratio}}{\text{required-return} - \text{growth}}$$

They derive a full dynamic model with time-varying growth, profitability, and risk:

$$\frac{V_t}{B_t} = 1 + v_e \frac{e_t + v - v_a \varepsilon^a_t}{B_t} + v_g \frac{g_t - \bar{g}}{B_t} - v_\pi \frac{\pi_t - \bar{\pi}}{B_t}$$

Where:

- $e_t$ = sustainable residual income (earnings minus cost of book capital)
- $\varepsilon^a_t$ = transitory earnings shocks (accruals that reverse)
- $g_t$ = growth in sustainable profits
- $\pi_t$ = risk premium (covariance of earnings with pricing kernel)

**Key insight**: Scaled price increases linearly in profitability (adjusted for accruals), growth, and safety (the negative of risk). This motivates a composite quality score.

### Quality Score Construction

Each component is a z-score of cross-sectional ranks, averaged across multiple measures:

**Profitability** = z(GPOA + ROE + ROA + CFOA + GMAR + ACC)

- GPOA: gross profits / assets
- ROE: net income / book equity
- ROA: net income / assets
- CFOA: cash flow / assets
- GMAR: gross margin
- ACC: low accruals (depreciation minus working capital changes)

**Growth** = z(5-year growth in residual per-share: ΔGPOA + ΔROE + ΔROA + ΔCFOA + ΔGMAR)

- Uses residual income (penalizes asset growth that doesn't generate proportional profits)
- Per-share basis (penalizes dilutive issuance)

**Safety** = z(BAB + LEV + O-Score + Z-Score + EVOL)

- BAB: minus market beta (Frazzini & Pedersen 2014)
- LEV: minus total debt / assets
- O-Score: Ohlson bankruptcy probability (negative)
- Z-Score: Altman bankruptcy score
- EVOL: minus earnings volatility (std of quarterly ROE)

**Overall Quality** = z(Profitability + Growth + Safety)

### The Price Puzzle

Cross-sectional regressions of log(market-to-book) on quality:

| Specification                        | Quality coefficient | R²  |
| ------------------------------------ | :-----------------: | :-: |
| Quality alone (US)                   |   0.22 (t=10.07)    | 9%  |
| Quality alone (Global)               |   0.17 (t=14.06)    | 9%  |
| With all controls + firm FE (US)     |   0.24 (t=20.92)    | 41% |
| With all controls + firm FE (Global) |   0.20 (t=24.97)    | 34% |

A one-standard-deviation increase in quality is associated with only 17–22% higher price-to-book. Quality IS priced — but weakly. Maximum R² is 49% even with all controls, leaving the majority of cross-sectional price dispersion unexplained.

### The Return of Quality-Sorted Portfolios

Decile portfolios sorted on quality (value-weighted, monthly rebalance):

**US Long Sample (1957–2016):**

| Decile        | Excess Return  | 4-Factor Alpha | Beta  |
| ------------- | :------------: | :------------: | :---: |
| P1 (Junk)     |    0.28%/mo    |   −0.59%/mo    | 1.28  |
| P10 (Quality) |    0.70%/mo    |   +0.46%/mo    | 0.92  |
| H−L spread    | 0.42% (t=2.56) | 1.05% (t=9.31) | −0.36 |

**Critical observation**: The alpha spread (105 bps/mo) is LARGER than the raw return spread (42 bps/mo) because high-quality stocks are simultaneously lower-risk. This means risk adjustment amplifies rather than explains quality returns.

### QMJ Factor Performance

Construction follows Fama-French: 2×3 sort on size × quality, long top 30% short bottom 30%, average across small and big.

**US (1957–2016):**

|               |        QMJ        | Profitability  |     Safety     |     Growth     |
| ------------- | :---------------: | :------------: | :------------: | :------------: |
| Excess return | 0.29%/mo (t=3.62) | 0.25% (t=3.69) | 0.23% (t=2.44) | 0.17% (t=2.46) |
| 4-factor α    | 0.60%/mo (t=9.95) | 0.50% (t=8.32) | 0.51% (t=8.39) | 0.46% (t=8.29) |
| Sharpe ratio  |       0.47        |      0.48      |      0.32      |      0.32      |
| Info ratio    |       1.40        |      1.17      |      1.18      |      1.16      |

**Global (1989–2016):**

|               |        QMJ        | Profitability  |     Safety     |     Growth     |
| ------------- | :---------------: | :------------: | :------------: | :------------: |
| Excess return | 0.38%/mo (t=3.33) | 0.39% (t=4.34) | 0.23% (t=1.72) | 0.15% (t=1.96) |
| 4-factor α    | 0.61%/mo (t=8.07) | 0.47% (t=6.89) | 0.39% (t=5.73) | 0.40% (t=5.78) |
| Sharpe ratio  |       0.64        |      0.83      |      0.33      |      0.37      |
| Info ratio    |       1.70        |      1.45      |      1.21      |      1.22      |

QMJ delivers positive returns in **23 out of 24 countries** (only tiny New Zealand is slightly negative). Statistically significant 4-factor alpha in 18/24 countries.

### Factor Loadings: Quality Is Safer, Not Riskier

QMJ factor loadings (4-factor model, US):

- MKT: **−0.20** (quality stocks have low beta)
- SMB: **−0.26** (quality stocks are larger)
- HML: **−0.37** (quality stocks are expensive → negative value loading)
- UMD: −0.09

**Every standard risk measure says quality stocks are safer than junk stocks**, yet they earn higher returns. This is the opposite of what risk-based asset pricing predicts.

### Flight to Quality (Not Crash Risk)

Performance during stress periods (US):

| Period                              | Excess Return | 4-Factor α |
| ----------------------------------- | :-----------: | :--------: |
| All periods                         |     0.29%     |   0.60%    |
| Recessions                          |     0.50%     |   0.82%    |
| Severe bear markets (−25% trailing) |     0.03%     |   0.78%    |
| High volatility                     |     0.13%     |   0.56%    |

QMJ performs BETTER during recessions and market stress. Mild positive convexity (benefits from flight to quality). **No evidence of crash risk or tail risk whatsoever.** This devastating for risk-based explanations.

### The Short Side Matters

The long/short structure is essential:

- Long quality alone: modest Sharpe (quality stocks earn higher returns but already have higher prices)
- Short junk alone: junk stocks earn deeply negative alpha (−0.59%/mo in US P1)
- **Combined L/S**: The short side contributes roughly half the alpha

Junk stocks are:

- High beta (1.28 vs 0.92 for quality)
- More expensive to short (lending fee 151 bps vs 38 bps)
- More shorted (utilization 23% vs 6%)
- Subject to larger analyst forecast errors

### Analyst Errors Are Systematic

| Quality decile | Implied expected return (analyst target) | Realized return |
| -------------- | :--------------------------------------: | :-------------: |
| P1 (Junk)      |                 26%/year                 |    2.4%/year    |
| P10 (Quality)  |                 15%/year                 |    6.8%/year    |

Analysts expect junk to outperform quality (26% vs 15% implied). Reality is the opposite. Earnings forecast errors are 6× larger for junk (−3.0% vs −0.5%).

### The Price of Quality Varies Over Time

The cross-sectional coefficient of quality on price-to-book fluctuates:

- **Lowest**: February 2000 (internet bubble peak)
- **Also low**: Before 1987 crash, before 2007–2009 crisis
- **Highest**: Late 1990 (Gulf War), late 2002 (post-Enron), early 2009 (banking crisis)

**Low price of quality predicts high future QMJ returns** (t-stat −3.59 at 60-month horizon). This is predictable mean reversion: when quality is cheap, buy it.

### QMJ Explains the Size Effect

When SMB is regressed on standard factors: small, insignificant alpha. Adding QMJ on the right-hand side:

- SMB loads **−0.64** on QMJ (small stocks are junky)
- SMB alpha jumps from 0.13 (t=1.26) to **0.49 (t=4.97)**

**The size effect is alive and well — you just need to compare small vs large stocks of similar quality.** Small stocks underperform because they are disproportionately junk.

### QMJ vs HML (Value)

QMJ and HML are **negatively correlated** — they are fundamentally different strategies:

- QMJ: buys based on quality characteristics, ignoring price
- HML: buys based on price (cheapness), ignoring quality
- Combining them ("Quality at a Reasonable Price", QARP) produces Sharpe ~0.7–0.9

Optimal QARP weighting: ~63% QMJ + 37% HML.

### Robustness

Survives: FF5 model, FF5+UMD (6-factor), 7-factor (adding BAB), subperiod splits (1957–88, 1989–2005, 2006–2016), all 10 size deciles, 71 GICS industries, large-cap only and small-cap only. Information ratio remains above 1.0 across nearly all specifications.

### Practical Implications

1. **Long/short is crucial.** QMJ's alpha is ~60 bps/mo, but the raw excess return is only 29 bps/mo. Roughly half the return comes from shorting junk. A long-only quality tilt captures only a fraction of the opportunity.

2. **Quality complements value.** QARP (buying cheap quality, shorting expensive junk) avoids the "value trap" — stocks that are cheap because they deserve to be cheap. QMJ is negatively correlated with HML.

3. **The pricing error is large.** Cumulative 5-year 4-factor alpha = 20.85% (US). This implies ~10.7% average underpricing of quality and ~10.7% overpricing of junk.

4. **Quality is persistent.** High-quality firms remain high-quality 10 years later (quality score spread: 1.14 at t+120 months vs 3.07 at formation). You can measure it ex ante.

5. **Risk-based explanations fail.** QMJ has negative beta, performs well in crises, shows no crash risk. Any risk-based theory must explain WHY safer stocks earn higher returns — the data categorically rejects the hypothesis that quality is risky.

6. **Analyst inefficiency is the mechanism.** Analysts systematically overestimate junk stock returns and underestimate quality stock returns. The errors are proportional to quality — not random.

7. **Time the price of quality.** When quality is cheaply priced (low cross-sectional regression coefficient), future QMJ returns are high. The internet bubble was the best time to buy quality.

### Relation to Other Papers in This Document

- **Fama & French (1992)**: BE/ME is the strongest cross-sectional predictor. QMJ is negatively correlated with HML — they are complementary, not competing. Adding QMJ to the RHS dramatically strengthens the size effect (SMB alpha from 0.13 to 0.49) and HML alpha (from 0.61 to 0.82). Quality explains WHY small stocks and value stocks earn premia — it's because they're junky.
- **Harvey & Liu (2021)**: Their panel regression identifies qmj (profitability) as the second most important factor after market in value-weighted tests. This paper is the detailed construction and validation of that factor.
- **Bailey et al.**: The quality score uses 6 profitability + 5 growth + 5 safety = 16 sub-measures. But these are not independent trials — they are averaged into one signal. The real multiple-testing concern is across the time-variation tests (Table 8) where return predictability is tested at multiple horizons.
- **Grinold & Kahn**: QMJ information ratio of 1.40 (US) to 1.70 (global) is exceptional — well above the IR≈1.0 threshold. The composite quality score (averaging many noisy sub-measures) is a textbook application of increasing IC by combining signals.

---

## Alberg & Lipton — Improving Factor-Based Quantitative Investing by Forecasting Company Fundamentals (2017, NeurIPS Workshop)

### Central Thesis

Standard value factors (EBIT/EV, book-to-market) rank stocks by _current_ fundamentals relative to price. But investment success depends on how well-priced the stock is relative to _future_ fundamentals. If you could see 12 months of future earnings (clairvoyantly), factor returns would roughly triple. Since you can't, the paper trains deep neural networks to _predict_ future fundamentals from trailing 5-year windows, then applies standard factors to the predicted values. This "Lookahead Factor Model" (LFM) significantly outperforms standard factor models.

### The Clairvoyance Simulation (Motivation)

Using an oracle that knows future fundamentals, they compute what factor models _would_ return if you could rank stocks by future EBIT/EV instead of current EBIT/EV:

| Months of clairvoyance | EBIT/EV CAR | Book/Market CAR |
| :--------------------: | :---------: | :-------------: |
|  0 (standard factor)   |    ~14%     |      ~12%       |
|        3 months        |    ~22%     |      ~18%       |
|        6 months        |    ~32%     |      ~25%       |
|       12 months        |  **~44%**   |      ~35%       |
|       24 months        |    ~55%     |      ~50%       |
|       36 months        |    ~70%     |      ~65%       |

**Key insight**: The gap between 0 and 12 months of clairvoyance is enormous (~14% → ~44% for EBIT/EV). Even a noisy prediction of future fundamentals, if it has any signal, should improve upon using current fundamentals. The value of prediction scales monotonically with lookahead distance.

### Why This Works (Conceptual)

Standard value investing logic:

1. Price < intrinsic value → buy
2. Intrinsic value ≈ f(current fundamentals)

The problem: current fundamentals are stale. A company currently earning $10/share might be earning $15/share next year (improving) or $5/share (deteriorating). The standard factor treats both identically. By predicting _future_ fundamentals, LFM distinguishes between:

- **Cheap AND improving** (buy — the stock is even more undervalued than it appears)
- **Cheap AND deteriorating** (avoid — the "cheapness" is warranted, i.e., value trap)

### Architecture and Data

**Universe**: 11,815 US stocks (NYSE/NASDAQ/AMEX), 1970–2017. Excludes financials, non-US, and micro-caps (<$100M inflation-adjusted).

**Input features** (20 total per time step):

- 16 fundamental features: revenue (TTM), COGS (TTM), SG&A (TTM), EBIT (TTM), net income (TTM), cash (MRQ), receivables (MRQ), inventories (MRQ), other current assets (MRQ), PP&E (MRQ), other assets (MRQ), current debt (MRQ), accounts payable (MRQ), taxes payable (MRQ), other current liabilities (MRQ), total liabilities (MRQ)
- 4 momentum features: price change over 1, 3, 6, 9 months (as cross-sectional percentile)

**Preprocessing**: All fundamentals scaled by market cap at the last input time step (so the network sees size-relative values). Then standardized to zero mean, unit variance.

**Input structure**: 5 annual snapshots (t−48, t−36, t−24, t−12, t) → predict all 16 fundamentals at t+12.

**Models tested**:

- MLP: 2 layers × 1024 hidden units, ReLU, batch norm, 50% dropout
- RNN (LSTM): 2 layers × 64 hidden units, layer norm, 70% recurrent dropout
- Linear regression (baseline)
- Naive predictor: assume fundamentals unchanged (baseline)

**Training**: In-sample 1970–1999, out-of-sample 2000–2016. 30% random validation within in-sample. Multi-task learning (predict all 16 fundamentals simultaneously, EBIT up-weighted by α₁). AdaDelta optimizer, early stopping after 25 epochs without improvement.

### Results

**Prediction quality (out-of-sample MSE, 2000–2016):**

| Model                          |   MSE    |
| ------------------------------ | :------: |
| Naive (fundamentals unchanged) |   0.62   |
| Linear regression              |   0.53   |
| **MLP**                        | **0.47** |
| **LSTM**                       | **0.47** |

Neural networks reduce MSE by 24% vs naive and 11% vs linear. The improvement is consistent across nearly all months in the out-of-sample period.

**Portfolio performance (out-of-sample, 2000–2016, EBIT/EV factor, top 50 stocks, equal weight, 1-year hold):**

| Strategy                              |    CAR    | Sharpe Ratio |
| ------------------------------------- | :-------: | :----------: |
| S&P 500                               |   4.5%    |     0.19     |
| Market average                        |   7.7%    |     0.29     |
| Price-LSTM (predict returns directly) |   11.3%   |     0.60     |
| **Standard factor model (QFM)**       | **14.4%** |   **0.55**   |
| LFM-Linear                            |   15.9%   |     0.63     |
| **LFM-MLP**                           | **17.1%** |   **0.68**   |
| LFM-LSTM                              |   16.7%   |     0.67     |

LFM-MLP beats the standard factor model by +2.7% CAR and +0.13 Sharpe.

### Portfolio Simulation Details

The backtester is industrial-grade (not naive):

- $100M AUM (inflation-adjusted to Jan 2010)
- Max 10% of monthly volume per security (liquidity constraint)
- Volume-weighted closing price over first 10 trading days of month
- Transaction costs: $0.01/share + quadratic slippage (1% at max participation)
- Dividends credited proportionally
- 1-year holding period, monthly rebalance of expired positions

### Why Predicting Fundamentals > Predicting Returns

Directly predicting returns with an LSTM: 11.3% CAR (mediocre, barely beats factor model). Predicting fundamentals then computing the factor: 17.1% CAR. Why?

1. **Signal-to-noise ratio**: Fundamentals are far less noisy than returns. Revenue next year is highly predictable from revenue this year. Returns next month are nearly random.
2. **Multi-task regularization**: Predicting 16 fundamentals simultaneously provides rich training signal and prevents overfitting to any single noisy target.
3. **Separation of concerns**: The network learns "what will the company look like?" (predictable). The factor formula translates that into "is it cheap?" (interpretable). Combining these is more robust than end-to-end return prediction.

### Practical Implications

1. **Factor models are a floor, not a ceiling.** Standard EBIT/EV already beats the market by ~7%/year. Replacing current EBIT with predicted-future EBIT adds another ~3%/year. The factor framework remains valid — you just feed it better inputs.

2. **Fundamentals are predictable.** The naive assumption (next year ≈ this year) has MSE 0.62. A simple neural network reduces this to 0.47 — a meaningful improvement that translates directly into portfolio performance.

3. **Predict intermediate targets, not end targets.** Predicting returns directly is hard (low SNR, easy to overfit). Predicting fundamentals is easier (high SNR, multi-task regularization). Then compute returns indirectly via a known-good factor formula.

4. **The value trap problem is partially solvable.** A stock that is "cheap" on current EBIT but whose EBIT is predicted to decline will rank lower in LFM than in a standard factor model. LFM naturally avoids deteriorating companies that appear cheap on stale data.

5. **Simple models work.** The MLP (2 layers, 1024 units) slightly outperforms the LSTM. The linear model is already competitive. The key innovation is the PROBLEM FORMULATION (predict fundamentals, not returns) rather than the model architecture.

6. **Multi-task learning as overfitting defense.** Predicting all 16 fundamentals provides far more training signal than predicting a single return target. This is consistent with Bailey et al.'s insight — more constraints on the optimization = less room to overfit.

### Limitations

- Long-only (top 50 stocks) — does not exploit shorting deteriorating companies
- Single factor (EBIT/EV) — could extend to multi-factor quality scores
- No out-of-sample walk-forward validation — single 2000–2016 test period
- US-only — no international replication
- Equal weight, 50 stocks — concentrated, but liquidity-constrained

### Relation to Other Papers in This Document

- **Fama & French (1992)**: Book-to-market (their key factor) is one of the factors tested here. The clairvoyance simulation shows that even B/M improves dramatically with future data — suggesting BE/ME's power partly comes from it being a noisy proxy for future fundamentals.
- **Asness et al. (QMJ)**: QMJ's profitability component (GPOA, ROE, ROA, CFOA) uses _current_ fundamentals. This paper's approach could directly enhance QMJ: predict future profitability measures, then compute the quality score on predicted values.
- **Bailey et al.**: The in-sample/out-of-sample split (1970–1999 / 2000–2016) is a single split — not CPCV. With 16 years of out-of-sample data and a pre-specified model, overfitting risk is modest but not zero. The hyperparameter search (architecture, α₁, α₂) constitutes unreported trials.
- **Grinold & Kahn**: The LFM approach effectively increases IC (information coefficient) of the EBIT/EV signal. Same factor, same universe, same rebalance — just a better forecast. This maps to higher IR with identical breadth.
- **Wang et al. (DBN)**: Both papers predict an intermediate quantity (PE\*/fundamentals) rather than returns directly. The separation of "estimate intrinsic value" from "compare to price" is a shared architectural choice.

---

## O'Neil — CAN SLIM: Growth Investing with Momentum Confirmation (1988/2009)

_From "How to Make Money in Stocks" (1st ed. 1988, updated 2009). Named top-performing strategy 1998–2009 by AAII. O'Neil died 2023._

### The System

CAN SLIM is a growth-stock selection strategy combining fundamental filters with technical timing. Each letter represents a criterion that historically preceded major price advances (study of winners 1953–2008):

| Letter | Criterion | Rule |
| :----: | --------- | ---- |
| **C** | Current quarterly earnings | EPS up ≥25% YoY in most recent quarter. Accelerating growth preferred. |
| **A** | Annual earnings growth | EPS up ≥25%/year over last 3 years. ROE ≥17%. |
| **N** | New product/service/management | The company must have a catalyst — new innovation, new leadership, or new price high (breakout). |
| **S** | Supply and demand | Volume surge on breakout day confirms institutional buying. Float matters (smaller float = bigger move potential). |
| **L** | Leader or laggard | Relative Strength rank ≥80 (stock in top 20% of 12-month price performance vs market). |
| **I** | Institutional sponsorship | Growing number of institutional holders in recent quarters. Quality of institutions matters (not just quantity). |
| **M** | Market direction | Only buy during confirmed market uptrends (S&P 500/NASDAQ). Three out of four stocks follow general market direction. |

### Risk Management

- **7-8% stop loss, no exceptions.** If a position drops 7-8% below buy point, sell immediately.
- **Buy at the breakout from a "base" pattern** (cup-with-handle, flat base), not on dips or averaged down.
- **Holding period**: Weeks to months. Sell on climax top, exhaustion gap, or when stock violates a moving average.

### What Is Quantifiable vs. What Is Not

| Component | Quantifiable? | Data source |
| --------- | :-----------: | ----------- |
| C (quarterly EPS growth) | Yes | Quarterly reports |
| A (annual EPS growth + ROE) | Yes | Annual reports |
| N (new product/catalyst) | No — qualitative judgment | Discretionary |
| S (volume on breakout) | Yes | Price/volume data |
| L (relative strength) | Yes | 12-month return rank |
| I (institutional ownership) | Partially | Ownership filings (lag) |
| M (market regime) | Partially — trend detection is quantifiable, confirmation is subjective | Index price data |

**For a quant system**: C, A, L, and S are fully automatable. N is inherently discretionary. I and M are partially quantifiable but require judgment calls on thresholds.

### Academic Support for Each Component

**C & A (Earnings momentum):** Well-documented. Post-Earnings Announcement Drift (PEAD) is one of the most robust anomalies in finance (Ball & Brown, 1968; Bernard & Thomas, 1989). Stocks with positive earnings surprises continue to outperform for 60–90 days. Earnings acceleration (growth of growth) has additional predictive power. The Alberg & Lipton (2017) paper in this document directly shows that predicting future fundamentals improves factor returns.

**L (Relative price strength / Momentum):** Jegadeesh & Titman (1993) documented that 12-month winners continue outperforming for 3-12 months. One of the few anomalies that survived decades of out-of-sample testing across international markets. BUT: momentum has catastrophic left-tail risk (momentum crashes of 2009, 2020). The strategy works until it doesn't, and when it fails, it fails violently.

**S (Volume confirmation):** Mixed academic evidence. Llorente et al. (2002) show volume predicts serial correlation direction. Lee & Swaminathan (2000) find past volume predicts momentum reversal speed. But volume alone is a weak signal — its value is mainly as confirmation of other signals.

**I (Institutional ownership):** Complicated. Some evidence that changes in institutional ownership predict returns (Yan & Zhang, 2009). But institutional herding also creates crowded trades that unwind violently. By the time ownership data is filed (13F filings have 45-day lag), the information is largely stale.

**M (Market direction):** Trivially true that buying in uptrends is better than buying in downtrends. The problem is identification in real-time. Trend-following systems (moving average crossovers, etc.) capture this partially but with significant lag and whipsaw costs.

### The Implementation Gap

The WSJ noted in February 2026 (after O'Neil's death): _"The late William O'Neil developed a stock-picking technique he called 'CAN SLIM.' It often produced outstanding hypothetical gains. But his two mutual funds struggled to generate decent returns."_

This is the single most important fact about CAN SLIM. Why does it work in hindsight but not in practice?

1. **N is doing the heavy lifting.** The "New product" criterion is what makes CAN SLIM selections look brilliant in retrospect. Of course the stocks that 10x'd had revolutionary products. But identifying this in real-time — before the market prices it in — is the entire problem of investing. It's not a systematic criterion; it's stock-picking skill dressed up as a rule.

2. **Survivorship bias in the study.** O'Neil studied stocks that DID make major price advances, then identified what they had in common beforehand. This is conditioning on the outcome. Many stocks meeting all CAN SLIM criteria at the time of their "breakout" subsequently failed — they just aren't in the study sample.

3. **Execution costs.** Buying on breakouts with volume confirmation means you're buying at the most expensive moment with the highest slippage. The 7-8% stop loss means frequent small losses that compound.

4. **The multiple-testing problem (Bailey et al.).** O'Neil tested his criteria across 50+ years of market winners. The criteria he selected are the ones that happened to be common among winners. With enough characteristics examined, some will appear by chance. The number of "trials" (characteristics screened) is not reported.

### Relevance in 2026: The AI Boom and P/E 150

CAN SLIM was formulated from data spanning 1953–2008. The current market regime — AI companies with P/E ratios of 100-200+ that continue gaining momentum for years — raises fundamental questions about whether the framework's parameters still apply.

**What still works:**

- **Earnings acceleration (C, A) IS the AI trade.** Companies like NVIDIA went from $5B to $60B+ in quarterly revenue in 3 years. CAN SLIM's 25% growth threshold would have flagged these early. The "A" criterion (annual growth ≥25% for 3 years) is not invalidated by high P/E — it's *why* P/E can be sustained at 150 if earnings are tripling.
- **Relative strength (L) still captures momentum.** The 12-month momentum factor has worked in the AI era. Leaders stay leaders for longer than value investors expect.
- **Market direction (M) saved you in 2022.** The NASDAQ fell 33%. CAN SLIM's "don't buy in downtrends" rule avoided most of the damage. It correctly captured that regime matters.

**What breaks:**

- **P/E is no longer a useful filter.** O'Neil never explicitly required low P/E, but the implicit assumption of his era was that P/E 30-40 was "expensive." In 2024-2026, the highest-momentum stocks routinely trade at P/E 50-200. A strict valuation filter would have excluded every major AI winner.
- **"New product" (N) is priced instantly.** In 1990, it took months for the market to process a new product announcement. In 2026, GPT-5 is priced in before it ships. The information edge from identifying "N" has compressed to near-zero for public information.
- **Volume signals are diluted by algorithmic trading.** When 70%+ of volume is algorithmic, a "volume surge on breakout" means algo-triggered momentum cascades, not informed institutional accumulation. The signal-to-noise ratio of volume has deteriorated.
- **The stop-loss creates whipsaw in volatile regimes.** AI stocks regularly draw down 15-25% then recover to new highs within weeks. A rigid 7-8% stop would have exited NVIDIA multiple times during its run from $100 to $1400.

### The Deeper Problem: Financial Knowledge Doesn't Compound

The user's intuition — "we don't know anything" — is supported by multiple lines of evidence:

**1. Strategies decay after publication.**
McLean & Pontiff (2016) showed that anomaly returns decline by ~58% post-publication. Once a pattern is known, it gets arbitraged. CAN SLIM was published in 1988. 38 years of crowd-following means the easy edge is gone.

**2. Market structure mutates.**
The market of 1953 (O'Neil's study start) had: no ETFs, no options market makers, no algorithmic trading, no retail apps, no social media, quarterly reporting delays of weeks. Every structural change alters which signals work and why. A strategy mined from 1953-2008 data is fitting a market that no longer exists.

**3. The factor zoo is largely noise.**
Harvey, Liu & Zhu (2016) documented 400+ published factors. Harvey & Liu (2021, summarized above) show that after multiple-testing correction, only 2-3 survive. The financial literature is mostly false discoveries dressed in statistical significance.

**4. Successful practitioners don't share their edge.**
Jim Simons's Medallion Fund returned ~66%/year for 30 years. He published nothing. The people writing books and teaching strategies are not the ones making money from them. O'Neil made his money from Investor's Business Daily subscriptions, not from CAN SLIM returns.

**5. Regime changes are unpredictable.**
Value investing dominated 1940-2006. Growth/momentum dominated 2007-2026 (with the brief exception of 2022). Nobody predicted the shift, nobody knows when (if) it reverses. A strategy optimized for one regime can underperform for decades in another.

### What CAN SLIM Gets Right (Conceptually)

Despite the implementation problems, CAN SLIM contains genuine insights that align with academic findings:

1. **Combine fundamentals with momentum.** This is essentially "quality + momentum" — the same insight as Asness's QARP (Quality at a Reasonable Price). Stocks with strong earnings AND strong price momentum outperform either criterion alone.

2. **Regime awareness matters.** The "M" criterion (only buy in uptrends) is crude market timing, but the core insight — that individual stock selection is dominated by market direction — is correct. Harvey & Liu (2021) show the market factor explains 44% of cross-sectional variation.

3. **Strict risk management.** The 7-8% stop loss is arbitrary, but the principle — cut losses mechanically without emotional override — is consistent with every successful systematic approach. Position sizing and loss management matter more than entry signals.

4. **Earnings growth IS the fundamental signal.** Alberg & Lipton (2017) show that predicting future earnings improves factor returns by ~3%/year. CAN SLIM's focus on earnings acceleration is conceptually aligned with "buy stocks whose fundamentals are improving faster than price implies."

### Quantifiable CAN SLIM Criteria for Vindros

If implementing a CAN SLIM-inspired screen with available Börsdata data:

| Criterion | Implementation | KPI / Data |
| --------- | -------------- | ---------- |
| C | Quarterly EPS growth ≥ 25% YoY | Quarterly reports (EPS) |
| A | 3-year EPS CAGR ≥ 25%, ROE ≥ 17% | Annual KPIs (EPS, ROE) |
| N | Not implementable systematically | — |
| S | Volume ratio (current / 50-day avg) > 1.5 on signal day | StockPrice volume data |
| L | 12-month return rank in top 20% of universe | StockPrice (computed) |
| I | Not available in Börsdata | — |
| M | Index above 200-day SMA | Index price data |

**Effective quantifiable filter**: C + A + L + M = earnings momentum + price momentum + market regime. This is a well-studied combination in the academic literature.

### Relation to Other Papers in This Document

- **Asness et al. (QMJ)**: CAN SLIM's C+A criteria overlap with QMJ's profitability and growth components. The key difference: QMJ is long/short and market-neutral; CAN SLIM is long-only and market-directional. QMJ's information ratio of 1.4 suggests the quality signal is real — but CAN SLIM only captures the long side.
- **Alberg & Lipton (2017)**: Their "Lookahead Factor Model" is the academic version of CAN SLIM's insight — stocks with improving fundamentals deserve higher prices. The difference: LFM uses neural networks to predict future earnings quantitatively, while CAN SLIM uses trailing reported earnings as a proxy.
- **Bailey et al. (2014)**: CAN SLIM is a textbook case of potential overfitting. Study sample = stock market winners from 1953-2008. Method = identify common characteristics post-hoc. Number of characteristics screened = unreported. The "winning" criteria are the ones that happened to be common among winners — classic survivorship bias combined with the multiple comparisons problem.
- **Fama & French (1992)**: CAN SLIM ignores book-to-market entirely. It is a pure growth/momentum strategy. In periods when value outperforms (most of 1940-2006), CAN SLIM-style approaches would have struggled. The decades-long regime dependence is a critical risk.
- **Harvey & Liu (2021)**: The "L" criterion (relative strength) is essentially the momentum factor. Momentum IS one of the few factors that survives multiple-testing correction in some studies — but it also has the worst crash risk among established factors.

---
