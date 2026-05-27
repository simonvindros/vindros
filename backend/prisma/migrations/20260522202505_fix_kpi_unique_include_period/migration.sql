/*
  Warnings:

  - A unique constraint covering the columns `[instrumentId,kpiId,reportType,priceType,year,period]` on the table `KpiValue` will be added. If there are existing duplicate values, this will fail.
  - Made the column `period` on table `KpiValue` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "KpiValue_instrumentId_kpiId_reportType_priceType_year_key";

-- AlterTable
ALTER TABLE "KpiValue" ALTER COLUMN "period" SET NOT NULL,
ALTER COLUMN "period" SET DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "KpiValue_instrumentId_kpiId_reportType_priceType_year_perio_key" ON "KpiValue"("instrumentId", "kpiId", "reportType", "priceType", "year", "period");
