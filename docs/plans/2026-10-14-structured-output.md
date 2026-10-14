# Plan: structured output, accurate annotations and an honest discovery manifest

- **Severity:** P1 (agents re-parse JSON text; one tool is wrongly marked as a write; the manifest over-claims)
- **Effort:** M

## Finding

Measured with `audit-live-mcp.mjs` (endpoint path changed from `/sse` to `/mcp`) against a local `dist/http.js` on `main` (248f38d): **4 fail / 6 warn / 12 pass**. The results relevant here:

- **WARN** `no tool sets outputSchema`. Every result is `JSON.stringify`'d into a text block (`src/utils/errors.ts:91`, `asToolResult`), so pricing figures and lists must be re-parsed by the model.
- **FAIL** `tools missing one of the 4 annotation hints`: all 27 tools. Every tool sets `readOnlyHint`/`openWorldHint` but omits `destructiveHint` (and most omit `idempotentHint`). Clients then fall back to the spec defaults, `destructive=true`.
- **WARN** `1 write tool callable (get_server_diagnostics)`. `src/tools/company.ts:213-215` marks it `readOnlyHint: false` because its `clear_cache` argument drops the page cache. Any anonymous caller can do that.
- `/.well-known/mcp.json` declares `capabilities.tools.listChanged: true` (`src/http.ts:186`). The tool set is fixed at build and the HTTP transport is stateless, with no stream to notify on. The audit's "listChanged is declared" PASS comes from the SDK default in `initialize`, not from any real notification.
- **FAIL** `the manifest hand-lists tools` (`src/http.ts:187`). This is a second copy of the tool surface.

## Proposed fix

1. **outputSchema + structuredContent** for:
   - `get_pricing`
   - `compare_pricing_across_markets`
   - `compare_with_competitor`
   - the list tools: `list_site_pages`, `list_features`, `list_integrations`, `list_solutions`, `list_free_tools`, `list_competitor_comparisons`, `list_blog_posts`, `list_resources`, `list_legal_documents`

   How:
   - Define zod output shapes next to each tool (e.g. `PricingOutput = { market, path, url, currency, price_range{low,high}, plan_count, plans[{name, price, currency, unit, description?}], faqs[], caveats[], date_modified? }`).
   - Add a shared `ListPage<T>` shape for `paginate()` results (`total`, `offset`, `limit`, `returned`, `has_more`, `results`).
   - Extend `asToolResult` with an optional `{ structured: true }` mode. It returns `structuredContent: value` plus the same JSON text block, for older clients.
   - Errors keep `isError` with no `structuredContent`. The SDK skips output validation when `isError` is set.
   - `compare_pricing_across_markets` per-market entries become a discriminated union: `{market, path, currency, plans}` or `{market, error}`.
   - **Prices are not changed.** Only the shape is declared. The static caveat strings at `src/tools/pricing.ts:51-56` stay as they are; add a code comment there noting they are static text, not read from the page.
2. **Annotations.** Add `destructiveHint: false, idempotentHint: true` to every read tool. A small `READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }` constant in `src/tools/shared.ts` keeps them consistent.
3. **`get_server_diagnostics`.**
   - Mark it `READ_ONLY`.
   - Remove the `clear_cache` argument from the public schema.
   - If the operator wants it, register `clear_cache` only when `MCP_ENABLE_ADMIN_TOOLS=1` (default off), as a separate `admin_clear_cache` tool with `readOnlyHint:false, destructiveHint:false`.
   - Recommendation: remove it. TTL expiry already handles staleness.
   - The test at `tests/tools.test.ts:371` uses `clear_cache` to reset state. Switch it to a fresh server instance.
4. **Manifest (`src/http.ts` `/.well-known/mcp.json`).**
   - Drop `capabilities.tools.listChanged`. Declare `capabilities: { tools: {} }`.
   - Replace `tools: [...names]` with `tool_count`. `tools/list` remains the source of names. The HTML status page keeps its list, which is generated at request time.
   - Also add `Access-Control-Allow-Origin: *` on this one GET route (audit WARN).

## Tests to add

- `tests/tools.test.ts`:
  - For each tool named above, `listTools()` shows an `outputSchema`, and `callTool()` returns `structuredContent` that validates against it. The SDK client validates automatically, so a mismatch fails the call.
  - Every tool has all four annotation hints, with `readOnlyHint === true`.
  - `get_server_diagnostics` has no `clear_cache` property.
- An HTTP test: `/.well-known/mcp.json` has no `listChanged`, has `tool_count === tools/list length`, and no `tools` array.

## Risks / rollout

- An outputSchema is a contract. A strict client rejects any result that does not match it, so keep optional fields optional (extracted data can be missing).
- Removing the `tools` array from the manifest could affect anything reading it. Nothing in the repo does.
- **Founder decision:** remove cache-clear entirely (recommended), or keep it behind `MCP_ENABLE_ADMIN_TOOLS`?

## Not checked

- The live surhires.com payload shapes (the sandbox egress proxy blocks it). Schemas would be derived from `src/clients/extract.ts` and the fixtures.
