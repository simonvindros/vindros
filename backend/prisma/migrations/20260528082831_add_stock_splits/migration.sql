-- CreateTable
CREATE TABLE "StockSplit" (
    "id" SERIAL NOT NULL,
    "instrumentId" INTEGER NOT NULL,
    "splitType" TEXT NOT NULL,
    "ratio" TEXT NOT NULL,
    "splitDate" TIMESTAMP(3) NOT NULL,
    "ratioFactor" DECIMAL(65,30) NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockSplit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockSplit_instrumentId_splitDate_key" ON "StockSplit"("instrumentId", "splitDate");
