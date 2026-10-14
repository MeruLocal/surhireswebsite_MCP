# Plan: share one SurhiresClient across HTTP requests and bound its cache

- **Severity:** P1 (performance and origin load; the cache never works over HTTP)
- **Effort:** S

## Finding

`src/http.ts:217-218` calls `buildServer()` for every `POST /mcp`, and `buildServer()` creates `new SurhiresClient(...)` (`src/server.ts:52`). The client owns:
- the 15-minute page cache,
- in-flight request coalescing,
- the `maxConcurrency` (4) outbound limit.

All three are therefore reset on every HTTP request:
- every tool call over HTTP refetches surhires.com;
- N parallel callers can open N×4 concurrent origin requests.

Measured on `main` (248f38d): I ran `dist/http.js` against a local fake origin that serves `tests/fixtures.ts` and counts hits, then called `get_pricing` twice over `POST /mcp`. The origin received **2** hits on `/in/pricing`. A prototype of the fix below received **1** hit.

The cache itself (`src/clients/surhires-client.ts:60`) is an unbounded `Map`. Today that is harmless because each client dies after one request. Once the client is shared for the life of the process, it needs a size bound.

The audit script (`audit-live-mcp.mjs`, with its endpoint path changed from `/sse` to `/mcp`) gives 4 fail / 6 warn / 12 pass on main. It does not observe this defect.

## Proposed fix

1. `src/server.ts` `BuildOptions`: add an optional `client?: SurhiresClient`. Use `options.client ?? new SurhiresClient(...)`.
2. `src/http.ts` `main()`:
   - Create one `SurhiresClient(config, log)` at startup.
   - Pass `{ client }` to every per-request `buildServer`.
   - Per-request servers and transports stay as they are (stateless).
3. `src/config.ts`: add `cacheMaxEntries` (env `SURHIRES_CACHE_MAX_ENTRIES`, default 500, range 1–100000).
4. `src/clients/surhires-client.ts`:
   - Make the cache LRU, using `Map` insertion order. On a hit, delete and re-set the entry. Delete expired entries when they are read.
   - New private `remember(target, html)` sets the entry, then evicts the first key while `size > cacheMaxEntries`.
   - `cacheStats()` also returns `max_entries`.
5. Document the new env var in the README env table and `.env.example`.

Stdio is unaffected: it already builds one client per process.

## Tests to add (`tests/client.test.ts`)

- LRU eviction with `SURHIRES_CACHE_MAX_ENTRIES=2`:
  - Read A, then B, then touch A, then read C.
  - Expect 2 entries, A still cached (1 origin call) and B evicted (2 calls).
- Two `buildServer({ client })` calls share the same client. A read through either one hits the origin once.

## Risks / rollout

- Memory is bounded by roughly 500 pages × the page size (typically 50–200 KB of HTML), so about 100 MB in the worst case. Lower the default if the host is small; a byte cap is a possible follow-up.
- Cached content can be up to 15 minutes stale across all callers. `get_server_diagnostics clear_cache` already exists (see the separate plan on gating it).
- There are no founder decisions needed.

## Not checked

- The live surhires.com (the sandbox egress proxy blocks it).
- Memory under real load.
