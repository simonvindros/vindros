/*
  Warnings:

  - A unique constraint covering the columns `[instrumentId,kpiId,reportType,priceType,year]` on the table `KpiValue` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `priceType` to the `KpiValue` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reportType` to the `KpiValue` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "KpiValue_instrumentId_kpiId_year_key";

-- AlterTable
ALTER TABLE "KpiValue" ADD COLUMN     "period" INTEGER,
ADD COLUMN     "priceType" TEXT NOT NULL,
ADD COLUMN     "reportType" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "KpiValue_instrumentId_kpiId_reportType_priceType_year_key" ON "KpiValue"("instrumentId", "kpiId", "reportType", "priceType", "year");
