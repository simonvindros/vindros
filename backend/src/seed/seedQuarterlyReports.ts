import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { loadProgress, saveProgress } from "../lib/progress";
import { z } from "zod";

const PROGRESS_FILE = "./report-progress.json";
const DELAY_MS = 50;

const reportSchema = z.object({
  year: z.number(),
  period: z.number(),
  revenues: z.number().nullable().optional(),
  gross_Income: z.number().nullable().optional(),
  operating_Income: z.number().nullable().optional(),
  profit_Before_Tax: z.number().nullable().optional(),
  earnings_Per_Share: z.number().nullable().optional(),
  number_Of_Shares: z.number().nullable().optional(),
  total_Equity: z.number().nullable().optional(),
  total_Assets: z.number().nullable().optional(),
  net_Debt: z.number().nullable().optional(),
  cash_And_Equivalents: z.number().nullable().optional(),
  free_Cash_Flow: z.number().nullable().optional(),
  cash_Flow_From_Operating_Activities: z.number().nullable().optional(),
  report_Start_Date: z.string().nullable().optional(),
  report_End_Date: z.string().nullable().optional(),
  report_Date: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  currency_Ratio: z.number().nullable().optional(),
});

export const seedQuarterlyReports = async () => {
  console.log("Seeding quarterly reports...");

  const instruments = await prisma.instrument.findMany({
    select: { id: true },
    where: { countryId: 1 },
  });

  const completed = loadProgress(PROGRESS_FILE);
  console.log(`${completed.size} instruments already processed`);

  let totalRecords = 0;
  let callsThisRun = 0;

  for (const instrument of instruments) {
    const key = `reports_${instrument.id}`;
    if (completed.has(key)) continue;

    try {
      const response = await api.get(
        `/instruments/${instrument.id}/reports/quarter`,
        { params: { maxCount: 40 } },
      );

      const reports = response.data?.reports;

      if (reports && reports.length > 0) {
        const parsed = z.array(reportSchema).parse(reports);

        const records = parsed.map((r) => ({
          instrumentId: instrument.id,
          year: r.year,
          period: r.period,
          revenues: r.revenues ?? undefined,
          grossIncome: r.gross_Income ?? undefined,
          operatingIncome: r.operating_Income ?? undefined,
          profitBeforeTax: r.profit_Before_Tax ?? undefined,
          earningsPerShare: r.earnings_Per_Share ?? undefined,
          numberOfShares: r.number_Of_Shares ?? undefined,
          totalEquity: r.total_Equity ?? undefined,
          totalAssets: r.total_Assets ?? undefined,
          netDebt: r.net_Debt ?? undefined,
          cashAndEquivalents: r.cash_And_Equivalents ?? undefined,
          freeCashFlow: r.free_Cash_Flow ?? undefined,
          cashFlowFromOperatingActivities:
            r.cash_Flow_From_Operating_Activities ?? undefined,
          reportStartDate: r.report_Start_Date
            ? new Date(r.report_Start_Date)
            : undefined,
          reportEndDate: r.report_End_Date
            ? new Date(r.report_End_Date)
            : undefined,
          reportDate: r.report_Date ? new Date(r.report_Date) : undefined,
          currency: r.currency ?? undefined,
          currencyRatio: r.currency_Ratio ?? undefined,
        }));

        await prisma.quarterlyReport.createMany({
          data: records,
          skipDuplicates: true,
        });

        totalRecords += records.length;
      }

      completed.add(key);
      saveProgress(PROGRESS_FILE, completed);
      callsThisRun++;

      if (callsThisRun % 100 === 0) {
        console.log(
          `  ${callsThisRun} instruments fetched, ${totalRecords} reports stored`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    } catch (error: any) {
      if (error?.response?.status === 404) {
        completed.add(key);
        saveProgress(PROGRESS_FILE, completed);
        callsThisRun++;
      } else {
        console.error(
          `Error fetching reports for instrument ${instrument.id}:`,
          error?.message || error,
        );
      }
    }
  }

  console.log(
    `✓ Quarterly reports: ${callsThisRun} instruments fetched, ${totalRecords} reports stored`,
  );
};
