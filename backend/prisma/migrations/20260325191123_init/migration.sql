-- CreateTable
CREATE TABLE "Instrument" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "isin" TEXT,
    "urlName" TEXT,
    "sectorId" INTEGER,
    "marketId" INTEGER,
    "branchId" INTEGER,
    "countryId" INTEGER NOT NULL,
    "listingDate" TIMESTAMP(3),
    "stockPriceCurrency" TEXT,
    "reportCurrency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPrice" (
    "id" SERIAL NOT NULL,
    "instrumentId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(65,30) NOT NULL,
    "high" DECIMAL(65,30) NOT NULL,
    "low" DECIMAL(65,30) NOT NULL,
    "close" DECIMAL(65,30) NOT NULL,
    "volume" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KpiMetadata" (
    "kpiId" INTEGER NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameSv" TEXT NOT NULL,
    "format" TEXT,
    "isString" BOOLEAN NOT NULL,

    CONSTRAINT "KpiMetadata_pkey" PRIMARY KEY ("kpiId")
);

-- CreateTable
CREATE TABLE "KpiValue" (
    "id" SERIAL NOT NULL,
    "instrumentId" INTEGER NOT NULL,
    "kpiId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "value" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KpiValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "marketId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("marketId")
);

-- CreateTable
CREATE TABLE "Sector" (
    "sectorId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Sector_pkey" PRIMARY KEY ("sectorId")
);

-- CreateTable
CREATE TABLE "Country" (
    "countryId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("countryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockPrice_instrumentId_date_key" ON "StockPrice"("instrumentId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "KpiValue_instrumentId_kpiId_year_key" ON "KpiValue"("instrumentId", "kpiId", "year");

-- AddForeignKey
ALTER TABLE "StockPrice" ADD CONSTRAINT "StockPrice_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiValue" ADD CONSTRAINT "KpiValue_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiValue" ADD CONSTRAINT "KpiValue_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "KpiMetadata"("kpiId") ON DELETE RESTRICT ON UPDATE CASCADE;
