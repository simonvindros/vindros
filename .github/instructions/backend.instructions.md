---
description: "Use when editing backend TypeScript files: Express routes, GraphQL resolvers, Prisma queries, seed scripts, API client code."
applyTo: "backend/src/**"
---

# Backend Conventions

- CommonJS modules (`"type": "commonjs"`) — use `import`/`export` syntax (ts-node handles it)
- Target ES2020 — `BigInt`, optional chaining, nullish coalescing are available
- Use `Decimal` (from Prisma) for monetary/financial values, never `number`
- Use `BigInt` for volume fields
- Prisma client singleton: import from `../lib/prisma` (or `../../lib/prisma` depending on depth)
- API client: import from `../lib/api` — automatically includes Börsdata auth key
- Environment variables loaded via `dotenv` at entrypoints only (`index.ts`, `seed/main.ts`)
- Use `upsert` for idempotent reference data writes, `createMany({ skipDuplicates: true })` for bulk inserts
