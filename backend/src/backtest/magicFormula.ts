import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../lib/prisma";
import { Decimal } from "../../generated/prisma/internal/prismaNamespace";

const getKpiValues = (
  kpiId: number,
  year: number,
  reportType: string,
  priceType: string,
) =>
  prisma.kpiValue.findMany({
    where: {
      kpiId,
      year,
      reportType,
      priceType,
    },
  });

const timeFrame = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];

export const magicFormulaBacktest = async (timeFrame: number[]) => {
  for (const year of timeFrame) {
    const ebitEv = await getKpiValues(17, year, "year", "mean");
    const roc = await getKpiValues(36, year, "year", "mean");
    const marketCap = await getKpiValues(50, year, "year", "mean");

    const ebitEvIdMap = new Map<number, Decimal | null>(
      ebitEv.map((company) => [company.instrumentId, company.value]),
    );
    const marketCapIdMap = new Map<number, Decimal | null>(
      marketCap.map((company) => [company.instrumentId, company.value]),
    );
    const matchingCompanies = [];

    for (const rocRecord of roc) {
      const rocId = rocRecord.instrumentId;
      if (ebitEvIdMap.has(rocId) && marketCapIdMap.has(rocId)) {
        const marketCapId = marketCapIdMap.get(rocId);
        if (Number(marketCapId?.valueOf() ?? 0) > 1000) {
          matchingCompanies.push({
            instrumentId: rocId,
            ebitEv: ebitEvIdMap.get(rocId),
            roc: rocRecord.value,
            marketCap: marketCapIdMap.get(rocId),
          });
        }
      }
    }

    const rankedMatchingCompaniesByEbitEv = matchingCompanies
      .filter((c) => c.ebitEv !== null)
      .sort((a, b) => Number(b.ebitEv)! - Number(a.ebitEv)!)
      .map((company, index) => ({
        ...company,
        ebitEvRank: index + 1,
      }));

    const rankedMatchingCompaniesByRocAndEbitEv =
      rankedMatchingCompaniesByEbitEv
        .filter((c) => c.roc !== null)
        .sort((a, b) => Number(b.roc)! - Number(a.roc)!)
        .map((company, index) => ({
          ...company,
          rocRank: index + 1,
        }));

    const companyIds = rankedMatchingCompaniesByRocAndEbitEv.map(
      (company) => company.instrumentId,
    );

    const companyNames = await prisma.instrument.findMany({
      where: { id: { in: companyIds } },
      select: { id: true, name: true },
    });

    const nameMap = new Map(
      companyNames.map((company) => [company.id, company.name]),
    );

    const combinedRankedCompanies = rankedMatchingCompaniesByRocAndEbitEv.map(
      (company) => {
        const companyName = nameMap.get(company.instrumentId);

        return {
          instrumentId: company.instrumentId,
          companyName: companyName,
          combinedRank: company.ebitEvRank + company.rocRank,
          marketCap: company.marketCap,
        };
      },
    );

    combinedRankedCompanies.sort((a, b) => a.combinedRank - b.combinedRank);

    const firstBuyStockPriceOfStock = async (instrumentId: number) =>
      await prisma.stockPrice.findFirst({
        where: {
          instrumentId,
          date: { gte: new Date(`${year + 1}-01-01`) },
        },
        orderBy: { date: "asc" },
      });

    const firstSellStockPriceOfStock = async (instrumentId: number) =>
      await prisma.stockPrice.findFirst({
        where: {
          instrumentId,
          date: { gte: new Date(`${year + 2}-01-01`) },
        },
        orderBy: { date: "asc" },
      });

    const top30companiesWithPrices = await Promise.all(
      combinedRankedCompanies.slice(0, 30).map(async (company) => {
        const buyPrice = await firstBuyStockPriceOfStock(company.instrumentId);
        const sellPrice = await firstSellStockPriceOfStock(
          company.instrumentId,
        );
        return {
          ...company,
          buyPrice: buyPrice?.close ?? null,
          sellPrice: sellPrice?.close ?? null,
        };
      }),
    );

    const returns = top30companiesWithPrices
      .filter((c) => c.buyPrice !== null && c.sellPrice !== null)
      .map(
        (company) =>
          (Number(company.sellPrice) - Number(company.buyPrice)) /
          Number(company.buyPrice),
      );

    const averageReturn =
      returns.reduce((sum, r) => sum + r, 0) / returns.length;

    const indexBuy = await firstBuyStockPriceOfStock(638);
    const indexSell = await firstSellStockPriceOfStock(638);
    const indexReturn =
      (Number(indexSell?.close) - Number(indexBuy?.close)) /
      Number(indexBuy?.close);

    console.log(
      `Magic formula ${year}: ${(averageReturn * 100).toFixed(2)}%, Index: ${(indexReturn * 100).toFixed(2)}%`,
    );
  }
};

magicFormulaBacktest(timeFrame);
