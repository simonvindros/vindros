---
name: prisma-migration
description: "Guide Prisma schema changes and migrations. Use when: modifying database models, adding columns, creating tables, updating relations, running prisma migrate."
---

# Prisma Migration

## When to Use
- Adding or modifying models in the Prisma schema
- Adding columns, indexes, or relations
- Any database schema change

## Procedure

1. Edit [backend/prisma/schema.prisma](../../../backend/prisma/schema.prisma)
2. Run migration from `backend/`:
   ```bash
   npm run prisma:migrate
   ```
   This runs `prisma migrate dev` which will:
   - Generate a new migration SQL file in `prisma/migrations/`
   - Regenerate the Prisma client in `generated/prisma/`
3. Verify the generated client types are correct — never edit files in `backend/generated/prisma/`

## Schema conventions

- Use `@id` with explicit IDs from the Börsdata API (not autoincrement) for entities that map to external data
- Use `@id @default(autoincrement())` for join/value tables (StockPrice, KpiValue)
- Use `@@unique` compound constraints for natural keys (e.g., `[instrumentId, date]`)
- Use `Decimal` for financial values, `BigInt` for volume
- Always add `createdAt DateTime @default(now())` to new models
- Add `@updatedAt` only when records are updated after creation

## Prisma client

- Singleton at [backend/src/lib/prisma.ts](../../../backend/src/lib/prisma.ts)
- Uses `@prisma/adapter-pg` (Prisma 7 driver adapter pattern)
- Generated to `backend/generated/prisma/` — do not edit
