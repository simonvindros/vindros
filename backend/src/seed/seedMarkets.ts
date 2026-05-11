import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
import { z } from "zod";

export const seedMarkets = async () => {
  console.log("Seeding markets...");

  const response = await api.get("/markets");
  const markets = response.data.markets;

  const marketSchema = z.object({
    id: z.number(),
    name: z.string(),
    countryId: z.number(),
    isIndex: z.boolean(),
    exchangeName: z.string().nullable(),
  });

  for (const market of markets) {
    const parsedMarket = marketSchema.parse(market);

    await prisma.market.upsert({
      where: { marketId: parsedMarket.id },
      update: {
        name: parsedMarket.name,
        countryId: parsedMarket.countryId,
        isIndex: parsedMarket.isIndex,
        exchangeName: parsedMarket.exchangeName,
      },
      create: {
        marketId: parsedMarket.id,
        name: parsedMarket.name,
        countryId: parsedMarket.countryId,
        isIndex: parsedMarket.isIndex,
        exchangeName: parsedMarket.exchangeName,
      },
    });
  }

  console.log(`✓ Seeded ${markets.length} markets`);
};
