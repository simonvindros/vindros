-- CreateTable
CREATE TABLE "QuarterlyReport" (
    "id" SERIAL NOT NULL,
    "instrumentId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "period" INTEGER NOT NULL,
    "revenues" DECIMAL(65,30),
    "grossIncome" DECIMAL(65,30),
    "operatingIncome" DECIMAL(65,30),
    "profitBeforeTax" DECIMAL(65,30),
    "earningsPerShare" DECIMAL(65,30),
    "numberOfShares" DECIMAL(65,30),
    "totalEquity" DECIMAL(65,30),
    "totalAssets" DECIMAL(65,30),
    "netDebt" DECIMAL(65,30),
    "cashAndEquivalents" DECIMAL(65,30),
    "freeCashFlow" DECIMAL(65,30),
    "cashFlowFromOperatingActivities" DECIMAL(65,30),
    "reportStartDate" TIMESTAMP(3),
    "reportEndDate" TIMESTAMP(3),
    "reportDate" TIMESTAMP(3),
    "currency" TEXT,
    "currencyRatio" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuarterlyReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuarterlyReport_instrumentId_year_period_key" ON "QuarterlyReport"("instrumentId", "year", "period");

-- AddForeignKey
ALTER TABLE "QuarterlyReport" ADD CONSTRAINT "QuarterlyReport_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
