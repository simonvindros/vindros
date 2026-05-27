-- CreateTable
CREATE TABLE "TechnicalIndicator" (
    "id" SERIAL NOT NULL,
    "instrumentId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "value" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicalIndicator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalIndicator_instrumentId_date_type_key" ON "TechnicalIndicator"("instrumentId", "date", "type");

-- AddForeignKey
ALTER TABLE "TechnicalIndicator" ADD CONSTRAINT "TechnicalIndicator_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
