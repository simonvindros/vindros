---
name: backend-seed
description: "Create new seed scripts for the Vindros backend. Use when: adding a new Börsdata data type, creating seed functions, ingesting API data into Postgres via Prisma."
---

# Backend Seed Script

## When to Use
- Adding a new data entity from the Börsdata API
- Creating a seed function for a new Prisma model

## Patterns

There are two seed patterns depending on data volume:

### Simple seeds (small datasets)
For reference data (countries, markets, sectors, instruments, kpiMetadata). See [seedCountries.ts](../../../backend/src/seed/seedCountries.ts).

1. Fetch all records from the API in one call
2. Upsert each record via `prisma.<model>.upsert()`
3. Log count when done

### Resumable seeds (large datasets)
For high-volume data (stockPrices, kpiValues). See [seedStockPrices.ts](../../../backend/src/seed/seedStockPrices.ts) and [seedKpiValues.ts](../../../backend/src/seed/seedKpiValues.ts).

1. Define a progress file constant: `const PROGRESS_FILE = "./<name>-progress.json"`
2. Load completed IDs: `loadProgress()` / `saveProgress()` from `../lib/progress`
3. Chunk work with `chunkArray()` from `../lib/chunks` (if batching by instrument)
4. Skip already-completed items via the progress set
5. Enforce a batch/daily limit so runs are bounded
6. Use `prisma.<model>.createMany({ skipDuplicates: true })`
7. Mark items complete and save progress **after** successful insert
8. Add a delay between API calls (`setTimeout`) for rate limiting

## Procedure

1. Create `backend/src/seed/seed<Entity>.ts` exporting an async function `seed<Entity>`
2. Choose simple or resumable pattern based on expected data volume
3. Add the function call to [backend/src/seed/main.ts](../../../backend/src/seed/main.ts) in the correct order (reference data first, then dependent data)
4. If resumable, add `<name>-progress.json` to `.gitignore`

## Key imports

```typescript
import { api } from "../lib/api";
import { prisma } from "../lib/prisma";
// For resumable seeds:
import { loadProgress, saveProgress } from "../lib/progress";
import { chunkArray } from "../lib/chunks";
```

## API client

The Börsdata API client is at `../lib/api.ts`. Base URL: `https://apiservice.borsdata.se/v1`. Auth key is passed automatically via params. Check the [Börsdata API docs](https://github.com/Borsdata-Sweden/API/wiki) for endpoints.
