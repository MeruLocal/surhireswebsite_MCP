# Plan: stop turning failed page fetches into confident empty or default values

- **Severity:** P1 (false facts an assistant repeats)
- **Effort:** S

## Finding

Several tools hide a failed fetch or a failed extraction behind a value that looks real:

| Where | What an agent sees |
|---|---|
| `src/tools/shared.ts:148-157` `fetchAll()` | drops every rejected page silently (`Promise.allSettled` then `filter(fulfilled)`). Callers cannot tell "page failed" from "page has no data". |
| `src/tools/catalog.ts:79-87` (`list_features` / `list_integrations` / `list_solutions`, `detail=true`) | a failed page falls back to the slug-derived name, `description: undefined` and **`faq_count: 0`** (`?? 0`). |
| `src/tools/catalog.ts:191-205` `list_free_tools`, `src/tools/content.ts:216-231` `list_resources`, `src/tools/content.ts:77-90` `list_blog_posts` | the same fallback, with no flag. |
| `src/tools/pages.ts:165` / `src/tools/content.ts:186` (`search_site` / `search_blog`, `deep=true`) | `pages_scanned` drops failures, so a search over pages that all failed returns "0 hits" rather than an error. |
| `src/tools/pricing.ts:95-102` `compare_pricing_across_markets` | if a pricing page loads but its offers do not parse, the market returns **`plans: []`** and `currency: undefined`, with no error. `get_pricing` throws `parseFailure` in the same case, so the two tools disagree. |

Measured on `main` (248f38d), local `dist/http.js` against a fake origin serving `tests/fixtures.ts`: `compare_pricing_across_markets {markets:["in","us"]}` returned INR plans for `in` and an explicit `error` for `us` (404). That 404 path is honest; the parse-failure path above is the silent one (by code reading).

## Proposed fix

1. `fetchAll()` returns `{ pages, failed: {path, error}[] }`.
2. Detail-mode list tools:
   - mark each item whose page failed with `detail_error: "<SurhiresError text>"`;
   - omit `faq_count` (rather than `0`) when the page was not read;
   - add `failed_count` at the top level.
3. Deep search: add `pages_failed`. If every page failed, return `isError` with the first error, not an empty result.
4. `compare_pricing_across_markets`: when a page has no parsable offers, return `{ market, error: parseFailure(...).message }`, matching `get_pricing`.

Prices are not touched; only how missing data is reported.

## Tests to add (`tests/tools.test.ts`, mock fetch)

- Script `/in/features/resume-parsing` to 500: `list_features detail=true` returns that item with `detail_error`, no `faq_count`, and `failed_count: 1`.
- All pages 500 in `search_site deep=true`: `isError` is true.
- A pricing fixture with no `Offer` nodes: `compare_pricing_across_markets` returns `error` for that market, not `plans: []`.

## Risks / founder decisions

- Output shape grows by optional fields only. If PR #5's output schemas land first, add these fields to them.
- No founder decision needed.

## Not checked

- Live surhires.com (sandbox egress blocked), so how often pages fail in practice is unknown.
