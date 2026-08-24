import dotenv from "dotenv";
dotenv.config();

import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { z } from "zod";

const MAX_COUNT = process.argv.includes("--full") ? 40 : 8;
const DELAY_MS = 110;

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

const parsePlausibleDate = (value?: string | null): Date | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;

  const lowerBound = new Date("2000-01-01T00:00:00.000Z");
  const upperBound = new Date();
  upperBound.setFullYear(upperBound.getFullYear() + 1);

  if (parsed < lowerBound || parsed > upperBound) return undefined;
  return parsed;
};

const main = async () => {
  try {
    console.log("Updating quarterly reports...");
    console.log(`Mode: ${MAX_COUNT === 40 ? "FULL" : "INCREMENTAL"}`);
    console.log(`Fetching up to ${MAX_COUNT} report(s) per instrument`);
    console.log("");

    const instruments = await prisma.instrument.findMany({
      select: { id: true, name: true },
      where: { countryId: 1 },
    });

    console.log(`  Swedish instruments: ${instruments.length}`);

    let apiCalls = 0;
    let totalRecords = 0;
    let totalUpserts = 0;

    for (let i = 0; i < instruments.length; i++) {
      const instrument = instruments[i];

      try {
        const response = await api.get(
          `/instruments/${instrument.id}/reports/quarter`,
          { params: { maxCount: MAX_COUNT } },
        );
        apiCalls++;

        const reports = response.data?.reports;
        if (reports && reports.length > 0) {
          const parsed = z.array(reportSchema).parse(reports);
          totalRecords += parsed.length;

          for (const report of parsed) {
            await prisma.quarterlyReport.upsert({
              where: {
                instrumentId_year_period: {
                  instrumentId: instrument.id,
                  year: report.year,
                  period: report.period,
                },
              },
              update: {
                revenues: report.revenues ?? undefined,
                grossIncome: report.gross_Income ?? undefined,
                operatingIncome: report.operating_Income ?? undefined,
                profitBeforeTax: report.profit_Before_Tax ?? undefined,
                earningsPerShare: report.earnings_Per_Share ?? undefined,
                numberOfShares: report.number_Of_Shares ?? undefined,
                totalEquity: report.total_Equity ?? undefined,
                totalAssets: report.total_Assets ?? undefined,
                netDebt: report.net_Debt ?? undefined,
                cashAndEquivalents: report.cash_And_Equivalents ?? undefined,
                freeCashFlow: report.free_Cash_Flow ?? undefined,
                cashFlowFromOperatingActivities:
                  report.cash_Flow_From_Operating_Activities ?? undefined,
                reportStartDate: parsePlausibleDate(report.report_Start_Date),
                reportEndDate: parsePlausibleDate(report.report_End_Date),
                reportDate: parsePlausibleDate(report.report_Date),
                currency: report.currency ?? undefined,
                currencyRatio: report.currency_Ratio ?? undefined,
              },
              create: {
                instrumentId: instrument.id,
                year: report.year,
                period: report.period,
                revenues: report.revenues ?? undefined,
                grossIncome: report.gross_Income ?? undefined,
                operatingIncome: report.operating_Income ?? undefined,
                profitBeforeTax: report.profit_Before_Tax ?? undefined,
                earningsPerShare: report.earnings_Per_Share ?? undefined,
                numberOfShares: report.number_Of_Shares ?? undefined,
                totalEquity: report.total_Equity ?? undefined,
                totalAssets: report.total_Assets ?? undefined,
                netDebt: report.net_Debt ?? undefined,
                cashAndEquivalents: report.cash_And_Equivalents ?? undefined,
                freeCashFlow: report.free_Cash_Flow ?? undefined,
                cashFlowFromOperatingActivities:
                  report.cash_Flow_From_Operating_Activities ?? undefined,
                reportStartDate: parsePlausibleDate(report.report_Start_Date),
                reportEndDate: parsePlausibleDate(report.report_End_Date),
                reportDate: parsePlausibleDate(report.report_Date),
                currency: report.currency ?? undefined,
                currencyRatio: report.currency_Ratio ?? undefined,
              },
            });
            totalUpserts++;
          }
        }

        if ((i + 1) % 100 === 0) {
          console.log(
            `  ${i + 1}/${instruments.length} instruments — ${apiCalls} API calls, ${totalUpserts} upserts`,
          );
        }
      } catch (error: any) {
        console.error(
          `  ✗ ${instrument.id} ${instrument.name}: ${error?.message || error}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }

    console.log("");
    console.log(
      `✓ Done — ${apiCalls} API calls, ${totalRecords} fetched reports, ${totalUpserts} upserts`,
    );
  } catch (error) {
    console.error("Update failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

main();