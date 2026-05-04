const resolvers = {
  Query: {
    instrument: (_: unknown, args: { id: number }, context: any) => {
      return context.prisma.instrument.findUnique({
        where: { id: args.id },
      });
    },
  },
};

export default resolvers;
