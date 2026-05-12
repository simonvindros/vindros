const resolvers = {
  Query: {
    instrument: (_: unknown, args: { id: number }, context: any) => {
      return context.prisma.instrument.findUnique({
        where: { id: args.id },
      });
    },
    instruments: (_: unknown, args: any, context: any) => {
      return context.prisma.instrument.findMany();
    },
    kpiMetadata: (_: unknown, args: { kpiId: number }, context: any) => {
      return context.prisma.kpiMetadata.findUnique({
        where: { kpiId: args.kpiId },
      });
    },
    kpiMetadatas: (_: unknown, args: any, context: any) => {
      return context.prisma.kpiMetadata.findMany();
    },
  },
  Instrument: {
    stockPrices: (parent: any, args: any, context: any) => {
      return context.prisma.stockPrice.findMany({
        where: { instrumentId: parent.id },
      });
    },
    kpiValues: (parent: any, args: any, context: any) => {
      return context.prisma.kpiValue.findMany({
        where: { instrumentId: parent.id },
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
