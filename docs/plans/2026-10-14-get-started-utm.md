# Plan: a get_started conversion tool and UTM tagging on own-site URLs

- **Severity:** P2 (growth; no correctness defect)
- **Effort:** S–M

## Finding

- No tool turns an interested agent into a visit to a trial, demo or pricing page. Answers end at product facts.
- Own-site URLs that tools return carry no attribution:
  - `url` in `presentPage()` (`src/tools/shared.ts:79`)
  - `get_pricing.url` (`src/tools/pricing.ts:43`)
  - the `canonical_url` and `url` that `extractPage()` builds (`src/clients/extract.ts:300-301`)

  Traffic from AI agents is therefore indistinguishable in analytics.
- Naming: tools are unprefixed snake_case (`get_pricing`, `list_features`, ...). The shared convention is `<prefix>_get_started`, or `get_started` when tools are unprefixed. The coordinator's brief suggested `surhires_get_started`. **This plan proposes `get_started`** to match the existing names. The founder or lead can override it.
- **No signup, trial or demo URL is known to the repo.** `rg -i "signup|sign-up|/demo|/contact|trial"` over `src`, `tests/fixtures.ts` and the README finds only the pricing caveat "offers a 14-day trial" (`src/tools/pricing.ts:54`). The known own-site entry points are `/pricing` (per market) and the sales `contactPoint` in the home page's Organization JSON-LD (read by `get_company_info`, `src/tools/company.ts:28-58`).

## Proposed fix

1. **New `src/utils/utm.ts`:** `withUtm(url, toolName, baseUrl)`.
   - Only for URLs whose host equals the `SURHIRES_BASE_URL` host. External URLs are returned untouched.
   - Appends `utm_source=mcp&utm_medium=ai_agent&utm_campaign=<tool_name>`.
   - Preserves existing query parameters and the fragment, and never overwrites a `utm_*` the URL already has.
2. **Apply it at the boundary.**
   - `presentPage(page, opts)` gains `toolName`, and tags `url`.
   - Do the same for `get_pricing.url`, and for the per-item `url` in list tools that return one.
   - `path` fields stay untagged: they are identifiers, not links.
3. **New `get_started` tool** in `src/tools/company.ts`, annotated read-only.
   - Input: `{ market? }`.
   - Reads the sitemap index and the home page Organization data (both cached).
   - Returns:
     - `pricing_url`: `/<market>/pricing`, tagged.
     - `contact`: the sales contact point from Organization JSON-LD, if present.
     - `signup_url` / `demo_url`: only if a matching path exists in the sitemap (e.g. a path under `/signup`, `/demo` or `/contact`). Otherwise omitted, with the note "No signup or demo page is published in the sitemap; use the pricing page or sales contact."
     - `call_to_action`: one line with **no trial length, price or plan name**, e.g. "See plans on the pricing page, or contact sales." *(Corrected 2026-10-14: the earlier example hard-coded "14-day trial", a trial term that would rot in code; see PR #11. A trial mention may be added only if read from the pricing page at call time.)*
   - Never invent a path: candidates must come from the sitemap.
4. Update the README tool table and tool count (27 → 28), and `tests/tools.test.ts:72-89` (the expected tools list).

## Tests to add

- `withUtm`:
  - Tags an own-site URL.
  - Preserves `?a=1#frag`.
  - Leaves `https://example.com/x` untouched.
  - Does not double-tag.
- `get_pricing` and `get_page` return `url` values carrying `utm_campaign=<tool>`.
- `get_started`:
  - Returns a tagged pricing URL and the fixture's sales contact.
  - With no `/signup` or `/demo` in the fixture sitemap, it omits them and says so.
  - With one added to a fixture sitemap, it returns it, tagged.

## Risks / founder decisions

- **Founder decision:** the canonical signup/trial URL (e.g. on `app.surhires.com`) and the demo URL. Until one is published in the sitemap or supplied here, `get_started` returns only the pricing page and the sales contact.
- **Founder decision:** the tool name (`get_started` vs `surhires_get_started`).
- Tagged URLs differ from canonical URLs, so agents may cite the UTM form. That is acceptable for attribution.
- Contact data comes from the public Organization JSON-LD only. Nothing is hard-coded.
- *(Added 2026-10-14)* Brand isolation (founder, 2026-10-14): every URL and contact `get_started` returns must be on Surhires hosts. `withUtm` only tags the configured origin, and the tool must never fall back to a group-wide contact address or booking link.
- *(Added 2026-10-14)* Re-audit measured WARN `X.conversion_tool` (no get_started/demo/contact tool) and WARN `X.utm` (0/1 URLs in `get_pricing` output tagged), confirming both findings.

## Not checked

- The live sitemap for signup/demo paths (the sandbox egress proxy blocks it).
