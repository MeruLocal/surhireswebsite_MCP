# Plan: hard-coded commercial facts and dated claims that will rot

- **Severity:** P1 (pricing, trial and status claims are quoted verbatim by assistants)
- **Effort:** S
- **Scope:** this plan changes no price, plan name or trial term. It moves static claims to where they can be checked and dated.

## Finding

These strings are fixed in code and returned as if read from the site:

| Where | Static claim |
|---|---|
| `src/tools/pricing.ts:51-56` `get_pricing.caveats` | "per recruiter seat per month and exclude indirect tax"; "The pricing page describes these figures as provisional"; "no free-forever tier; it offers a 14-day trial" |
| `src/tools/pricing.ts` description, and `compare_pricing_across_markets.note` | "Surhires labels them provisional" |
| `src/tools/company.ts:76-83` `get_api_and_mcp_status` | `verified_at_build: "2026-10-13"` and five summary sentences, beside live page text that may say otherwise |
| `src/tools/company.ts:162` `get_trust_and_security` description | "describes its SOC 2 work as a readiness programme" |
| `src/tools/pricing.ts:118` `list_competitor_comparisons` description | a hand list of 13 competitors (the tool reads the sitemap, so the description can drift from the result) |
| descriptions in `catalog.ts` / `content.ts` | counts such as "~45", "~40", "~33 posts" |

If the pricing page changes (trial length, tax wording, "provisional" removed), the tool keeps telling agents the old terms with no date and no source. Not verifiable today: the sandbox cannot reach surhires.com, and these terms need the founder's canonical source in any case.

## Proposed fix

1. **Caveats from the page, not from code.** In `get_pricing`, keep only caveats that can be derived:
   - billing unit and currency from the `Offer` nodes (already extracted);
   - "provisional", trial and tax wording only if the page body or pricing FAQ contains it, quoted with its source (`{ text, source: "pricing FAQ" }`).
   Anything that cannot be found is omitted, not asserted.
2. **Dated static claims.** Where a static sentence must stay (`get_api_and_mcp_status.summary`), return it as `{ claim, verified_on: "2026-10-13", source_url }` and say in the description that the live `pages` text wins on conflict.
3. **Descriptions.** Drop the competitor list and the "~N" counts from tool descriptions; the tools return the live lists.
4. **Freshness check.** A test (or CI step from PR #8) fails when a `verified_on` date is older than 90 days, prompting a re-check.

## Tests to add

- Pricing fixture without trial wording: no trial caveat is returned.
- Pricing fixture with "14-day trial" in its FAQ: the caveat is returned with `source`.
- `get_api_and_mcp_status` summary entries carry `verified_on`.
- No tool description matches `/~\d+|Bullhorn, Greenhouse/`.

## Risks / founder decisions

- **Founder decision:** the canonical source for trial length, tax treatment and the "provisional" label. Until then, the plan only stops asserting what the page does not say; it does not restate any term.
- PR #6 (`get_started`) proposes a call-to-action mentioning a 14-day trial; a correction there points to this plan.
- PR #5 keeps the caveat strings with a code comment; this plan supersedes that comment if both are approved.

## Not checked

- Live pricing page wording (sandbox egress blocked).
