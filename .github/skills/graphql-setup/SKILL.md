---
name: graphql-setup
description: "Wire up Apollo Server with Express in the Vindros backend. Use when: adding GraphQL schema, creating typeDefs, writing resolvers, integrating Apollo Server middleware."
---

# GraphQL Setup

## When to Use
- Wiring Apollo Server into the Express app for the first time
- Adding new GraphQL types, queries, or mutations
- Creating resolvers that query Prisma models

## Current State
- `@apollo/server` and `graphql` are already installed (see [package.json](../../../backend/package.json))
- Express app exists at [backend/src/index.ts](../../../backend/src/index.ts) — only a `/health` endpoint, no Apollo middleware yet
- Prisma models: Instrument, StockPrice, KpiMetadata, KpiValue, Market, Sector, Country (see [schema.prisma](../../../backend/prisma/schema.prisma))

## Procedure

### Initial wiring (first time only)
1. Create `backend/src/graphql/typeDefs.ts` — export a `gql` tagged template with the GraphQL schema
2. Create `backend/src/graphql/resolvers.ts` — export a resolvers object with Query (and Mutation if needed)
3. Update `backend/src/index.ts`:
   - Import `ApolloServer` from `@apollo/server`
   - Import `expressMiddleware` from `@apollo/server/express4`
   - Create server with typeDefs + resolvers
   - Call `await server.start()` before `app.listen()`
   - Mount `app.use("/graphql", express.json(), expressMiddleware(server))`
4. Pass `{ prisma }` as context to `expressMiddleware` so resolvers can access the Prisma client

### Adding a new query/type
1. Add the type definition to `typeDefs.ts`
2. Add the resolver to `resolvers.ts`
3. Use the Prisma client from context: `context.prisma.<model>.findMany()`

## Conventions
- Use `Decimal` and `BigInt` scalars — map Prisma `Decimal` to `Float` in GraphQL, `BigInt` to `String` or a custom scalar
- Follow existing backend conventions from [backend.instructions.md](../../instructions/backend.instructions.md)
- Keep resolver logic thin — complex queries should be in a separate service/util layer
- Domain knowledge for KPI types is in [docs/kpi-guide.md](../../../docs/kpi-guide.md)
