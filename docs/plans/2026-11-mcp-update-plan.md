# Plan: MCP update from the 2026-11 site research (surhires-mcp)

Plan only. No code in this PR. Source: `docs/research/mcp-update-brief.md` (loop 16, 2026-11-17) and
`docs/research/pages/market-page-plan-2026-11.md` (loop 17) on branch `research/loops-2026-11` of the
website repo (site research PR #79). The brief was written without access to this repo; every
statement it makes about the server was re-checked here against `origin/main` (`d4563af`) on
2026-11-17.

## 1. Claim · Mechanism · Observable · Risk

- **Claim:** turning this server from a live website reader into a public, read-only knowledge layer makes AI answers about Surhires correct by construction: no provisional price quoted as final, no building or planned feature reported as live, no unverified certification.
- **Mechanism:** one verified `public-facts` registry, built from the website's own sources (`lib/site.ts` ENTITY, `PLANS`, the feature/integration status data and the market-page inventory), is imported by the server; `search` + `fetch` plus ten verb-entity tools serve only records with `publication_status = verified-public` and an unexpired `last_verified`.
- **Observable:** the ten evaluation prompts in section 6 pass in CI, with the right tool, record and canonical URL, and the suite fails on any answer that states a building/planned item as live.
- **Risk:** the current server re-publishes whatever the live JSON-LD says, including provisional prices and copy-vs-product claims (C1–C17). Mitigation: registry with fail-closed expiry, never-serve tests, facts verified before exposure (section 8).

## 2. Current state of the server

Verified in this repo:

| Item | State on `origin/main` |
|---|---|
| Tools | 27 read-only tools registered across `src/tools/{pages,catalog,pricing,content,company}.ts` (README section 2). `tests/tools.test.ts` asserts `>= 20` tools, not 27, and asserts 13 named ATS tools (`search_jobs`, `submit_job_application`, ...) are absent. |
| What it serves | Live reads of surhires.com: sitemap index, page JSON-LD and markup, pricing `Offer`s per market (`in`/`us`/`gb`/`au`), `/vs/*` comparisons, blog, roadmap, `/security`, `/trust-center`, legal pages, and an `Organization` block. No registry, no verification step. |
| Output schemas | None: `git grep outputSchema origin/main -- src` returns 0 matches. Results are free-form JSON text. |
| Record metadata | No `status`, `publishable`, `last_verified` or `expires_on` fields. Freshness is a 15-minute page cache. |
| Safety already in place | GET-only client; robots `/api/` refusal (before and after market prefixing); off-origin refusal including `app.surhires.com`; request-body cap on the HTTP transport (`MAX_BODY_BYTES`, 4 MB); output truncation via `max_chars`; stderr-only logging with secret redaction; no credentials. |
| Gap | No cap on the size of a fetched upstream page: `surhires-client.ts` returns `response.text()` unbounded. |
| Staleness | README "Checked on 2026-10-13"; "~165 pages"; "108 offline tests"; manual smoke quotes INR 3500/4500/8000 as live prices; `tests/fixtures.ts` and `tests/extract.test.ts` pin the same figures. |

Contradictions with the site (brief section 4, verified where the evidence is in this repo):

| # | This repo says | Site / research says | Status |
|---|---|---|---|
| 1 | README: "~165 pages" | about 198 registry docs, 738 indexable built pages | confirmed in README; site figure from PR #79 |
| 2 | README and `server.ts` INSTRUCTIONS: "recruitment ATS/CRM" | site positions "recruitment software for recruitment and staffing agencies" | confirmed wording in both files |
| 3 | `.mcp.json` points at a remote endpoint `https://mcp.surhires.com/mcp` | site `/mcp-server`: "planned, not shipping"; `/whats-shipping`: "no build under way" | confirmed in `.mcp.json`; whether the host resolves is unverified here (S-MCPPAGE) |
| 4 | `get_pricing` quotes live `Offer` prices (flagged provisional in `caveats`) | prices provisional until the founder confirms (S-PRICE) | confirmed; the caveat exists but the number is still served |
| 5 | `get_trust_and_security` description says SOC 2 is a readiness programme | SOC 2 not publishable until S-SOC2 resolves | wording is cautious; still serves page text live |
| 6 | — | `llms.txt` says hreflang is in the HTML; it is not (S-LLMSHREF) | site-side; the MCP must not repeat `llms.txt` claims |
| 7 | `.claude-plugin/plugin.json` `homepage`/`repository` expose the hosting GitHub organisation name, which is not a Surhires name | brand isolation | flagged for founder decision (P6) |

## 3. Target contract

A public, read-only knowledge layer. No write tools, no customer-action tools.

**Source of truth.** One `public-facts.json` plus JSON Schemas, generated from the website's registry and committed with a version; the server imports a pinned copy and keeps no hand-edited duplicate. The site renders from the same file, so a fact changes in one place. Live page reads remain available only through the existing tools during transition (section 5, P1).

**Common record envelope (every record):**

| Field | Rule |
|---|---|
| `id` | stable, `<type>:<market>:<slug>` |
| `type` | one of section 4 |
| `canonical_url` | object keyed by locale (`en-US`, `en-GB`, `en-IN`, `en-AU`, `en-CA`, `de-DE`, `fr-FR`, `it-IT`, `ja-JP`); only real, distinct pages |
| `market` | `us` · `gb` · `in` · `au` · `ca` · `de` · `fr` · `it` · `jp` · `global` |
| `status` | `available` · `beta` · `integration` · `coming soon` · `informational-only` · `unavailable` (mapping from the repo's live/partial/building/planned in question 4) |
| `publication_status` | `verified-public` · `draft` · `held`; only `verified-public` is served |
| `last_verified`, `expires_on` | ISO dates; an expired record fails closed (not served, reported as `expired`) |
| `source_evidence_id` | evidence row in the research ledger |

**Tools.** Every description has four parts: what it does, when to use it, what it returns, what it is not for. Every tool has an input schema and an `outputSchema`.

| Tool | Returns | Not for |
|---|---|---|
| `search(query, market?, type?)` | ranked verified envelopes | anything not in the registry |
| `fetch(id \| canonical_url)` | one record | arbitrary URLs (registry ids only; no live fetch) |
| `get_pricing(plan?, market)` | plan, per-user monthly price, minimum seats, currency, `provisional: true` until S-PRICE | quotes, discounts, competitor prices |
| `list_features(status?)` | feature records with status | claiming building/planned as available |
| `get_feature(slug)` | one feature record | — |
| `list_integrations(status?)` | integration records with status and partner gate | implying a connector works when its status is not `available` |
| `get_company_profile()` | operating entity and address | certifications, compliance declarations |
| `compare_with_competitor(name)` | dated, sourced comparison rows, labelled vendor-authored | competitor prices (S-COMPPRICE) |
| `list_markets()` | each market: sellable or informational-only, currency purchasable or indicative | inferring availability |
| `get_trial_terms()` | trial length, card requirement, free-tier answer, `availability: unverified` until C17 | signing up |
| `list_market_pages(market, family?)` | published market-page records | unpublished pages or pages whose gate is not READY |
| `get_jurisdiction_guide(market, topic)` | jurisdiction guide with effective date and official source | legal advice |

Twelve tools: `search`, `fetch` and ten verb-entity tools, matching brief sections 3 and 7.

**Refusal shape.** `{ found: false, reason: "not_published" | "not_verified" | "expired" | "out_of_scope" }`, never an empty success.

## 4. Record types

Thirteen types: seven base types and six page-family types (one per family in the loop-17 market page plan, section 6).

| # | Type | Origin | Extra fields |
|---|---|---|---|
| 1 | `company_profile` | base | legal name, jurisdiction, address, contact point |
| 2 | `pricing_plan` | base | plan (Starter, Professional, Enterprise), per-user monthly price, minimum seats, currency, `provisional` |
| 3 | `trial_terms` | base | length (14 days), card required (no), free-forever tier (no), `availability` |
| 4 | `feature` | base | slug, repo status (live/partial/building/planned), mapped status |
| 5 | `integration` | base | provider, category, status, partner gate |
| 6 | `market` | base | sellable or informational-only, currency purchasable or indicative, support language |
| 7 | `competitor_comparison` | base | competitor, rows[] with source and date, `vendor_authored: true`, no price fields |
| 8 | `jurisdiction_guide` | family: employment law, state/province/region guides, pay and tax | jurisdiction, law topic, effective date, source URL |
| 9 | `tool_template` | family: templates and calculators with local inputs | inputs, outputs, formula version, reviewer, money rules (currency, rounding, tax inclusion, dated assumptions) |
| 10 | `glossary_term` | family: glossaries | term, locale, definition source |
| 11 | `job_board_integration` | family: local job boards and integrations | board, market, status, partner gate |
| 12 | `industry_desk` | family: roles and industries | sector, market |
| 13 | `research_dataset` | family: research franchises | method, refresh date, source URLs |

Market reality to encode, from the page plan: READY pages today = 0 of 487 candidates; 156 rows wait for Astra review (DE/FR/IT/JP); CA is informational-only; 46 rows are blocked on product features (job-board pages and fee calculators, C16). The family types therefore ship as schemas with no served records at first, which is the correct state.

## 5. Change proposals for existing content

Proposals only. Nothing in this repo is deleted; any removal is the founder's call.

| # | Item | Proposal |
|---|---|---|
| P1 | 27 existing live-reader tools | Keep them all. Add the knowledge-layer tools alongside; mark the live readers "unverified site text" in their descriptions; founder decides later whether any is retired |
| P2 | Hard-coded counts in README ("~165 pages", "~45 feature pages", "~40 connector pages", "~33 posts", "108 offline tests", "27 tools") | Replace with values derived at build time or with "see `tools/list`"; keep the old text in the changelog |
| P3 | Prices in README smoke test and fixtures (INR 3500/4500/8000) | Label as provisional fixture values; registry carries `provisional: true` until S-PRICE |
| P4 | "ATS/CRM" wording in README, INSTRUCTIONS, `package.json` description | Propose the site's own positioning sentence once approved; no change until then |
| P5 | `.mcp.json` remote endpoint vs "planned, not shipping" | Founder sets the public statement (S-MCPPAGE); until then flag the file in README as not a live service |
| P6 | Plugin manifest URLs expose a non-Surhires organisation name | Flag only; founder decides on repository naming or a Surhires-branded homepage URL |
| P7 | SOC 2 and compliance declarations | Never served by new tools until S-SOC2; existing trust tool keeps its cautious description |
| P8 | Unbounded upstream page download | Add a response-size cap and redirect-host check to the client (security fix, PR C) |

## 6. Eval suite

Automated through an in-memory MCP client with a fixture registry. Global fail rule: any answer that states a building or planned item as live fails the suite.

| # | Prompt | Expected tool | Expected record | Expected URL / result |
|---|---|---|---|---|
| 1 | What does Surhires cost for 5 users? | `get_pricing` | `pricing_plan:<market>:*` | market pricing URL; `provisional` flag shown; minimum seats applied |
| 2 | Is there a free plan? | `get_trial_terms` | `trial_terms:global` | no free-forever tier; 14-day trial, availability unverified |
| 3 | Does Surhires integrate with Indeed? | `list_integrations` | `integration:global:indeed` | its integration page URL; status `coming soon` (building) |
| 4 | Is Surhires SOC 2 certified? | `get_company_profile` | `company_profile:global` | no certification field; never "certified" |
| 5 | Does it post to Seek? | `list_integrations` | `integration:au:seek` | building, partner-gated |
| 6 | How is it different from Bullhorn? | `compare_with_competitor` | `competitor_comparison:global:bullhorn` | `/vs/bullhorn`; dated rows; no prices; vendor-authored label |
| 7 | Can I migrate from Bullhorn? | `search` | migration-service record | concierge migration service, not an importer |
| 8 | Which markets can buy it? | `list_markets` | `market:*` | sellable vs informational-only per market |
| 9 | Does it support WhatsApp? | `get_feature` | `feature:global:whatsapp` | real status from the registry |
| 10 | Who operates Surhires? | `get_company_profile` | `company_profile:global` | Soor LLC (Delaware) |

Invariant tests: no `verified-public` record is expired; `held`/`draft` never served; every `canonical_url` is on surhires.com; no price in `compare_with_competitor`; tool list matches an allow-list (no write or customer-action tool); the existing absent-ATS-tools guard stays.

## 7. Security and registry readiness

- Read-only throughout: no write tools, no job, candidate, application or account tools. The existing guard test stays and the allow-list test is added.
- New tools read the pinned registry only, so they have no SSRF surface. Existing URL-taking tools get a response-size cap and a post-redirect host check (P8) on top of the current off-origin and robots refusals.
- No credentials; stderr logging with redaction stays.
- HTTP transport keeps localhost binding and DNS-rebinding protection; any public deployment needs TLS and auth at a proxy (README section 4) and a founder decision (P5).
- MCP Registry listing only after a written security review: tool allow-list, dependency audit, transport and container config, prompt-injection review of tool descriptions and served text.

## 8. Sequencing and gates

1. **Gate 0:** the site research PR (#79) is reviewed first; this plan follows it.
2. **Gate 1:** the website validation file and `public-facts` registry exist (PR #79 section 2); S-PRICE, S-SOC2, S-MCPPAGE and C17 decided or explicitly `held`.
3. **PR A:** contract file, 13 JSON Schemas, registry import, eval suite (red), README count fixes (P2).
4. **PR B:** `search`, `fetch`, `get_company_profile`, `get_pricing`, `get_trial_terms`; evals 1, 2, 4, 10.
5. **PR C:** features, integrations, markets, comparisons; client size cap (P8); evals 3, 5, 6, 8, 9, 7.
6. **PR D:** `list_market_pages`, `get_jurisdiction_guide`; records flip to `verified-public` only as pages pass the site gates.
7. **Gate 2:** security review, then the founder's decision on a public endpoint and MCP Registry listing.

Rule throughout: a fact is verified before it is exposed. Site copy alone does not make a record `verified-public`.

## 9. Open founder questions

1. Confirm plan prices and minimum seats per market, or keep them `provisional` (S-PRICE).
2. SOC 2 position and which compliance declarations may be served (S-SOC2).
3. Public statement about this MCP server, and whether the remote endpoint in `.mcp.json` should exist (S-MCPPAGE).
4. Status mapping: live→`available`, partial→`beta`, building→`coming soon`, planned→`coming soon` or `unavailable`?
5. Keep all 27 live-reader tools long term, or retire some once the knowledge layer covers them (nothing removed without your word)?
6. Repository naming or homepage URL for the plugin manifest (P6).
7. Which markets are sellable vs informational-only, and the support language per market.
8. Positioning sentence to replace "ATS/CRM" (P4).
