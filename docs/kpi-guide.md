# KPI Guide

A plain-language reference for every financial metric in the Vindros database. See [kpiCombinations.ts](../backend/src/config/kpiCombinations.ts) for which KPIs are seeded.

## How to read this

Almost every metric is one of four things:

1. **"How many years of X to pay back the price"** — valuation ratios
2. **"What % of revenue survives to become profit/cash"** — margins
3. **"What % return does the company generate on its capital"** — return metrics
4. **"How much bigger/smaller vs last year"** — growth rates

None of these are useful alone. The power comes from combining them.

## Dimensions

Each KPI value in the database has two extra dimensions:

- **reportType**: `year` (annual report), `r12` (rolling 12 months — last 4 quarters summed), `quarter`. R12 is more current than year — if a company's annual report is from December but it's now October, the r12 figure includes the latest quarterly data.
- **priceType**: `mean` (average price that year), `high`, `low`. For a ratio like P/E: using `low` price gives you the most optimistic (cheapest) P/E, `high` gives the most pessimistic. `mean` is the middle ground.

---

## Valuation — "Am I paying a fair price?"

| Metric | The number tells you... |
|--------|------------------------|
| **P/E = 20** | "At today's profits, I'm paying the equivalent of 20 years of earnings" |
| **P/S = 3** | "I'm paying 3 years worth of the company's total revenue" |
| **P/B = 1.5** | "I'm paying 1.50 SEK for every 1 SEK of net assets on the books" |
| **P/FCF = 15** | "At today's cash generation, 15 years of real cash equals my price" |
| **P/EBIT = 12** | "12 years of operating profit (before tax/interest) to pay back my price" |
| **P/EBITDA = 10** | "Same, but also before depreciation — so a more generous view, 10 years" |
| **EV/EBIT = 14** | "If I bought the entire company (stock + its debts - its cash), it takes 14 years of operating profit to pay that off" |
| **EV/EBITDA = 11** | "Same idea, more generous, 11 years" |
| **EV/S = 2** | "The whole company (debt-adjusted) costs 2 years of revenue" |
| **EV/FCF = 16** | "The whole company costs 16 years of real cash flow" |
| **PEG = 0.8** | "The P/E is 0.8× the growth rate — I'm paying less than 1 SEK per 1% of growth. Under 1 looks cheap, over 2 looks expensive." |
| **EBIT/EV (%)** | The inverse — "the company earns X% of its total value per year in operating profit." Think of it like an interest rate on your investment. 8% = good, 3% = meh. |

### P/ vs EV/ — why both?

Price-based ratios (P/) ignore debt. Two companies can have the same P/E, but one has 5 billion in debt and the other has zero. EV-based ratios are more honest — they show what you'd really pay to own the whole business. Think of it like buying a house: the price tag (P/) is one thing, but the total cost including the mortgage you take over (EV/) is the real number.

### P/E and tech — why so high?

A P/E of 80 means "at current profits, it takes 80 years to earn back the price." That sounds absurd. But the market isn't pricing current profits — it's pricing *expected future* profits. If a tech company is growing earnings 40% per year, those 80 years compress fast because next year's earnings are 1.4x this year's. The danger is when the growth doesn't materialize — that's how tech bubbles pop.

### P/B below 1 — bargain or trap?

Book value = everything the company owns (buildings, machines, cash, patents) minus everything it owes (loans, bills). P/B below 1 means the market values the company at less than its accounting net worth — buying a krona for 80 öre. This can mean:

1. **Genuine bargain** — the market is pessimistic and you're getting a deal
2. **Value trap** — the market knows something the accounting doesn't (overvalued inventory, declining assets, cash bleeding)

Never use one metric alone.

### Cash vs Earnings — why P/FCF matters

**Earnings** (profit) is an *accounting* number. A company can "earn" 100 million SEK on paper while having zero cash in the bank:

- Sold products on credit (counted as revenue) but haven't collected the cash yet
- Spread a big expense over 10 years ("depreciation") even though they paid it all upfront
- Capitalized R&D spending (put it on the balance sheet as an "asset" instead of an expense)

**Free Cash Flow** is simpler and harder to fake: how much actual cash flowed into the company, minus what it spent on maintaining/growing the business (capex). Many professional investors trust P/FCF more than P/E.

---

## Profitability — "How efficiently does this company make money?"

All margins answer: **"Out of every 100 SEK in revenue, how many SEK survive to this level?"**

| Metric | Meaning |
|--------|---------|
| **Gross margin = 65%** | "65 SEK out of 100 remain after subtracting the direct cost of making the product" |
| **EBITDA margin = 30%** | "30 SEK remain after also paying salaries, rent, admin — but before depreciation, interest, tax" |
| **Operating margin = 22%** | "22 SEK remain after depreciation too — the real operational profit" |
| **Profit margin = 16%** | "16 SEK actually become net profit after everything including tax and interest" |
| **OCF margin = 18%** | "18 SEK of operating cash — before capital expenditures are subtracted" |
| **FCF margin = 12%** | "12 SEK become actual spendable cash. The most conservative." |

The cascade is: Gross → EBITDA → Operating → Profit → Cash. Each step subtracts more costs. A company with a high gross margin but low profit margin has high overhead. A company where profit margin is much higher than FCF margin might have aggressive accounting.

---

## Return Metrics — "How hard is the company's money working?"

These answer: **"For every 100 SEK of [capital type], the company generates X SEK of profit per year."**

| Metric | Meaning |
|--------|---------|
| **ROE = 18%** | "Every 100 SEK shareholders have invested generates 18 SEK of profit per year" |
| **ROA = 8%** | "Every 100 SEK of total assets (shareholder money + borrowed money) generates 8 SEK" |
| **ROIC = 14%** | "Every 100 SEK of capital actively invested in the business generates 14 SEK" |
| **ROC = 12%** | Similar to ROIC, slightly different definition of "capital" |

Think of it like interest on a savings account — but for the company's invested capital. ROE of 18% means the company compounds shareholder wealth at 18%/year. Warren Buffett famously looks for consistent ROE above 15%.

**Why ROE can be misleading:** A company can boost ROE by taking on massive debt (less equity in the denominator = higher ratio). That's why you cross-check with equity ratio and debt metrics.

---

## Financial Health — "Can this company survive hard times?"

| Metric | Meaning |
|--------|---------|
| **Equity ratio = 45%** | "45% of everything the company owns is funded by shareholders, 55% by debt. Middle of the road." |
| **Debt/Equity = 1.2** | "For every 1 SEK of shareholder money, there's 1.20 SEK of debt. Moderately leveraged." |
| **Net debt/EBITDA = 2.5** | "It would take 2.5 years of operational earnings to pay off all debt (net of cash). Under 3 is comfortable, above 4 is risky." |
| **Current ratio = 1.8** | "The company has 1.80 SEK of short-term assets for every 1 SEK of short-term bills. Above 1 = can pay its bills. Below 1 = potential trouble." |
| **Cash-% = 15%** | "15% of total assets is cash. High cash = safe but possibly inefficient." |

---

## Growth — "Is the company getting bigger or shrinking?"

All growth metrics are: **"This number is X% bigger (or smaller) than last year."**

| Metric | Meaning |
|--------|---------|
| **Revenue growth = 12%** | "The company sold 12% more this year than last year" |
| **Earnings growth = 8%** | "Profits grew 8%" |
| **EBIT growth = -5%** | "Operating profit actually shrank by 5% — costs grew faster than revenue" |
| **Equity growth = 10%** | "The company's net worth grew 10% — it retained and reinvested profits" |
| **Dividend growth = 8%** | "The dividend increased 8% vs last year" |

---

## Dividends — "How much cash does the company return to me?"

| Metric | Meaning |
|--------|---------|
| **Dividend yield = 3.5%** | "If I buy this stock today, I get 3.5% of my investment back in cash dividends per year. Like interest on a bond." |
| **Payout ratio = 55%** | "The company pays out 55% of its profits as dividends and keeps 45% to reinvest. Balanced." |
| **Dividend/FCF = 70%** | "70% of real cash flow goes to dividends. If this exceeds 100%, the company is borrowing or using savings to pay dividends — unsustainable." |

---

## Absolute Financials

These are the raw numbers (in SEK millions typically) that the ratios above are derived from. Useful for filtering ("only stocks with revenue above 1 billion") and sanity-checking.

| Metric | What it is |
|--------|------------|
| **Revenue** | Total sales |
| **Gross profit** | Revenue minus direct production costs |
| **EBITDA** | Earnings before interest, tax, depreciation, amortization |
| **Operating income (EBIT)** | Revenue minus all operating costs including depreciation |
| **Profit before tax** | EBIT minus interest costs |
| **Earnings** | Net profit — the bottom line after everything |
| **Free Cash Flow** | Operating cash minus capital expenditures — actual spendable cash |
| **Operating Cash Flow** | Cash generated from business operations |
| **Capex** | Capital expenditures — money spent on equipment, buildings, etc. |
| **Total Assets** | Everything the company owns |
| **Total Equity** | Assets minus liabilities — shareholder net worth |
| **Net Debt** | Total debt minus cash. Negative = more cash than debt |
| **Market Cap** | Stock price × number of shares — what the market says the company is worth |
| **Enterprise Value** | Market Cap + debt - cash — what it would cost to buy the entire company |
| **Number of Shares** | Outstanding shares (needed to calculate per-share metrics) |

### Per-share versions

Revenue/share, earnings/share (EPS), book value/share, FCF/share, EBITDA/share, etc. — same numbers divided by number of shares. Useful for comparing across time when share count changes (dilution, buybacks).
