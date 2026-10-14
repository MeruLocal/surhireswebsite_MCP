# Plan: cap response size and paginate every list

- **Severity:** P2 (agent quality; context cost)
- **Effort:** S

## Finding

- **No overall response cap.** Per-call `max_chars` goes up to 100,000 on `get_page`, `get_feature`/`get_integration`/`get_solution`, `get_blog_post` and `compare_with_competitor`, and up to 60,000 per page on multi-page tools (`get_trust_and_security`, `get_roadmap`: two pages each). `rg -n "max\(100_000\)|max\(60_000\)|max\(40_000\)" src` finds 9 such arguments. A single result can exceed 100k characters, above what many clients accept (~25k is the common guidance).
- **Lists without pagination:** `list_resources` (`src/tools/content.ts:208-231`), `list_free_tools` (`src/tools/catalog.ts:184-205`), `list_legal_documents` (`src/tools/company.ts:191-201`) and `alternatives_pages` inside `list_competitor_comparisons` return everything. Other list tools already return `total/offset/limit/has_more`.

The audit PASSes `C2.titles` and `C2.descriptions`; it does not measure response size.

## Proposed fix

1. `src/utils/errors.ts` `asToolResult`: after serialising, if the text exceeds `MCP_MAX_RESPONSE_CHARS` (default 25,000), trim the largest string field (`body_text`) first and add `response_truncated: true` with a hint to lower `max_chars` or page. Never cut JSON mid-structure.
2. Lower the default upper bound of `max_chars` to 25,000; keep higher values available via env for stdio users.
3. Add `limit`/`offset` and the shared `paginate()` to the four unpaginated lists.

## Tests to add

- A fixture page of 200k characters: `get_page max_chars=100000` returns ≤ 25k characters, valid JSON, `response_truncated: true`.
- `list_resources limit=1` returns `has_more` when there are 2 resources.

## Risks

- Agents relying on very long pages will need to page through with `max_chars`. No founder decision.

## Not checked

- Real page sizes on surhires.com (sandbox egress blocked).
