const resolvers = {
  Query: {
    instrument: (_: unknown, args: { id: number }, context: any) => {
      return context.prisma.instrument.findUnique({
        where: { id: args.id },
      });
    },
    instruments: (
      _: unknown,
      args: { limit?: number; offset?: number },
      context: any,
    ) => {
      const { limit = 50, offset = 0 } = args;

      return context.prisma.instrument.findMany({
        take: Math.min(limit, 500),
        skip: offset,
      });
    },
    kpiMetadata: (_: unknown, args: { kpiId: number }, context: any) => {
      return context.prisma.kpiMetadata.findUnique({
        where: { kpiId: args.kpiId },
      });
    },
    kpiMetadatas: (
      _: unknown,
      args: { limit?: number; offset?: number },
      context: any,
    ) => {
      const { limit = 50, offset = 0 } = args;

      return context.prisma.kpiMetadata.findMany({
        take: Math.min(limit, 500),
        skip: offset,
      });
    },
  },
  Instrument: {
    stockPrices: (
      parent: any,
      args: { limit?: number; offset?: number },
      context: any,
    ) => {
      const { limit = 100, offset = 0 } = args;

      return context.prisma.stockPrice.findMany({
        where: { instrumentId: parent.id },
        take: Math.min(limit, 500),
        skip: offset,
      });
    },
    kpiValues: (
      parent: any,
      args: { limit?: number; offset?: number },
      context: any,
    ) => {
      const { limit = 100, offset = 0 } = args;

      return context.prisma.kpiValue.findMany({
        where: { instrumentId: parent.id },
        take: Math.min(limit, 500),
        skip: offset,
      });
    },
    technicalIndicators: (
      parent: any,
      args: { limit?: number; offset?: number },
      context: any,
    ) => {
      const { limit = 100, offset = 0 } = args;

      return context.prisma.technicalIndicator.findMany({
        where: { instrumentId: parent.id },
        take: Math.min(limit, 500),
        skip: offset,
      });
    },
  },
  KpiValue: {
    kpi: (parent: any, args: any, context: any) => {
      return context.prisma.kpiMetadata.findUnique({
        where: { kpiId: parent.kpiId },
      });
    },
  },
};

export default resolvers;
