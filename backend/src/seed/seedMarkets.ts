import { api } from "../lib/api";
import { prisma } from "../lib/prisma";

export const seedMarkets = async () => {
  console.log("Seeding markets...");

  const response = await api.get("/markets");
  const markets = response.data.markets;

  for (const market of markets) {
    await prisma.market.upsert({
      where: { marketId: market.id },
      update: {
        name: market.name,
        countryId: market.countryId,
        isIndex: market.isIndex,
        exchangeName: market.exchangeName,
      },
      create: {
        marketId: market.id,
        name: market.name,
        countryId: market.countryId,
        isIndex: market.isIndex,
        exchangeName: market.exchangeName,
      },
    });
  }

  console.log(`✓ Seeded ${markets.length} markets`);
};
