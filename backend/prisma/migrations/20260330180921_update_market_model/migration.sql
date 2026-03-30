/*
  Warnings:

  - Added the required column `countryId` to the `Market` table without a default value. This is not possible if the table is not empty.
  - Added the required column `isIndex` to the `Market` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "countryId" INTEGER NOT NULL,
ADD COLUMN     "exchangeName" TEXT,
ADD COLUMN     "isIndex" BOOLEAN NOT NULL;
