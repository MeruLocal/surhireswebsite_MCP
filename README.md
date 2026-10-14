# surhires-mcp

The official MCP server for [Surhires](https://surhires.com/in), a recruitment ATS/CRM operated by Soor LLC.

**Read this part first.** Surhires publishes **no API**. This server reads Surhires' public website and nothing else. It cannot search candidates, post jobs, submit applications or read a pipeline, because no authorized interface exists to do so. The analysis behind that claim, and what would change it, is in [Verified integration options](#verified-integration-options).

---

## 1. Analysis of Surhires and its integration options

### What Surhires is

Not a job board — a **B2B recruitment ATS and CRM**, sold per recruiter seat to staffing agencies, recruitment firms and in-house talent teams. Candidate records with resume parsing, drag-and-drop pipelines, workflow automation, interview scheduling, analytics, client/placement tracking and placement invoicing. Tenant data lives behind a login at `app.surhires.com`. The operating company is Soor LLC, Lewes, Delaware, USA.

The public site (~165 pages) covers features, integrations, solutions by vertical, pricing per market, competitor comparisons, long-form resources, a blog, and legal/trust pages.

### Verified integration options

Checked on **2026-10-13**. Every finding is reproducible with the command shown.

| Check | Result | How to reproduce |
|---|---|---|
| `robots.txt` | `Disallow: /api/` for **every** user agent, ClaudeBot included | `curl https://surhires.com/robots.txt` |
| `docs.surhires.com` | DNS does not resolve | `curl -sS https://docs.surhires.com/` |
| `developers.surhires.com` | DNS does not resolve | same |
| `api.surhires.com` | DNS does not resolve | same |
| `/openapi.json`, `/.well-known/*` | 404 (Next.js app shell) | `curl -o /dev/null -w '%{http_code}' https://surhires.com/openapi.json` |
| `/mcp-server` | *"The Surhires MCP server is planned, not shipping."* No transport, scopes, tool ids or date | `curl -sSL https://surhires.com/mcp-server` |
| `/whats-shipping` | MCP server listed under **"no build under way"**, gated on "the permission model being right" | `curl -sSL https://surhires.com/whats-shipping` |
| `/integrations/zapier` | Zapier app *"in development for Wave 1"*, **"not usable today"**; developer docs publish *"when the app ships"* | `curl -sSL https://surhires.com/integrations/zapier` |
| Public API docs search | Nothing on the domain | web search |

**Conclusion.** No public REST API, no API-key or OAuth flow, no developer documentation, no authenticated MCP surface for tenant data, and the one programmatic surface that exists (`/api/`) is robots-disallowed and undocumented. There is therefore nothing to authenticate against and no endpoint that could be called without inventing it.

**What this server does instead.** It exposes the one surface that is real, public and crawl-permitted: the published website, read through its schema.org structured data. That turns out to be genuinely useful — pricing, feature claims, connector status, competitor positioning and compliance posture are all published — and it is honest about its limits.

**The authenticated layer is left as a seam, not a stub.** `src/clients/` is where a real API client would go, `src/tools/` is where its tools would be registered, and nothing in the architecture assumes the website is the only possible source. No placeholder ATS tools were written, because a tool that cannot work is worse than a tool that does not exist.

---

## 2. Supported tools

27 tools, all read-only. The "reads" column is the actual page or data source — no tool calls anything undocumented.

### Discovery and search

| Tool | What it does | Reads |
|---|---|---|
| `list_site_pages` | Every published page, filterable by section or substring | `/sitemap.xml` + child sitemaps |
| `get_page` | Any page: metadata, outline, body, tables, FAQs | the page's JSON-LD + markup |
| `search_site` | Keyword search; `deep=true` searches full body text and FAQ answers | sitemap, then pages |
| `get_page_faqs` | Just the Q&A pairs — often where the real caveats are | the page's `ItemList` of `Question` |

### Product catalogue

| Tool | What it does |
|---|---|
| `list_features` / `get_feature` | ~45 feature pages (`detail=true` fetches real titles/descriptions) |
| `list_integrations` / `get_integration` | ~40 connector pages |
| `list_solutions` / `get_solution` | ~14 vertical/audience pages |
| `list_free_tools` | Public calculators and generators Surhires hosts |

### Pricing and competitors

| Tool | What it does | Reads |
|---|---|---|
| `get_pricing` | Plans, prices, currency, billing unit, pricing FAQ, caveats | `SoftwareApplication` → `AggregateOffer` → `Offer` |
| `compare_pricing_across_markets` | Same plans across `in`/`us`/`gb`/`au`, no currency conversion | four pricing pages |
| `list_competitor_comparisons` | Competitors with a head-to-head page | `/vs/*` + `/alternatives-to-*` |
| `compare_with_competitor` | One comparison in full, table included, flagged as vendor-authored | `/vs/<slug>` |

### Content

| Tool | What it does |
|---|---|
| `list_blog_posts` / `get_blog_post` / `search_blog` | ~33 posts; dates and author from `BlogPosting` |
| `list_resources` | Long-form guides under `/resources` |
| `get_changelog` | Release policy (may be empty **by design** — see the tool's note) |
| `get_roadmap` | `/roadmap` + `/whats-shipping`: what ships vs what is planned |

### Company, status and diagnostics

| Tool | What it does |
|---|---|
| `get_company_info` | Operating entity, legal name, address, contacts, from `Organization` |
| `get_api_and_mcp_status` | **Live** answer on whether an API/MCP/Zapier surface exists yet |
| `get_integration_status` | Whether a named connector actually works today, with its status sentences |
| `get_trust_and_security` | `/security` + `/trust-center` |
| `list_legal_documents` | Terms, privacy, DPA, GDPR, DPDPA, CCPA, EEO/OFCCP and the rest |
| `get_server_diagnostics` | This server's config, cache state and live reachability |

### Tools deliberately **not** implemented

`search_jobs`, `get_job_details`, `search_candidates`, `get_candidate_details`, `get_my_applications`, `submit_job_application`, `get_application_status`, `create_job_listing`, `update_job_listing`, `manage_candidate_pipeline`, `get_my_profile`, `update_my_profile`, `get_account_information`.

Every one needs an authenticated API Surhires does not publish. A test in `tests/tools.test.ts` asserts none of them is advertised, so they cannot creep in as fakes.

---

## 3. Install and build

Requires Node.js 20 or newer (developed on 26).

```bash
npm install
npm run build
```

Optional config — every setting has a working default:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|---|---|---|
| `SURHIRES_BASE_URL` | `https://surhires.com` | Origin to read |
| `SURHIRES_MARKET` | `in` | `in` \| `us` \| `gb` \| `au` |
| `SURHIRES_TIMEOUT_MS` | `15000` | Per-request timeout |
| `SURHIRES_MAX_RETRIES` | `2` | Retries on 429/5xx/network/timeout |
| `SURHIRES_MAX_CONCURRENCY` | `4` | Parallel requests cap |
| `SURHIRES_CACHE_TTL_MS` | `900000` | Page cache TTL (0 disables) |
| `SURHIRES_CACHE_MAX_ENTRIES` | `500` | Most pages held in the cache (least recently used evicted first) |
| `SURHIRES_MAX_PAGE_BYTES` | `5242880` | Outbound pages larger than this are refused, not read |
| `SURHIRES_CONTACT` | `unspecified` | Contact string in the User-Agent. **Must be a Surhires address** (or left unset): it reaches every proxy and log viewer between this server and the origin |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` (stderr only) |
| `PORT` / `MCP_HTTP_HOST` | `3000` / `127.0.0.1` | HTTP transport only |
| `MCP_RATE_LIMIT_PER_MIN` | `60` | HTTP only: `POST /mcp` requests per minute per client (`0` disables); over it, `429` with `Retry-After` |
| `TRUST_PROXY` | unset | HTTP only: set `1` behind your own reverse proxy so the rate limit keys on the right-most `X-Forwarded-For` hop. Leave unset when nothing sits in front, or a caller can choose its own key |
| `MCP_HTTP_DEEP_MAX_PAGES` | `10` | HTTP only: most pages one tool call may fetch (deep search, `detail=true` lists). Stdio keeps each tool's own maximum |
| `MCP_ALLOWED_ORIGINS` | unset | HTTP only: extra browser `Origin`s allowed to call `/mcp`, comma-separated (`*` = any). Requests without an `Origin` (non-browser clients) are unaffected |
| `MCP_PUBLIC_BASE_URL` | unset | HTTP only: the public `https://` origin advertised on `/` and in `/.well-known/mcp.json`, e.g. `https://mcp.surhires.com`. Never taken from the request's `Host` |

**There is no credential setting, and that is deliberate** — adding one would imply an authenticated surface that does not exist.

### Run

```bash
npm start
```

```bash
npm run start:http
```

---

## 4. Connect to Claude Desktop

### Local (stdio) — the normal path

Edit the config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "surhires": {
      "command": "node",
      "args": ["C:\\Users\\Hp\\Desktop\\Surhires_MCP\\dist\\index.js"],
      "env": {
        "SURHIRES_MARKET": "in",
        "SURHIRES_CONTACT": "you@example.com",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Use an **absolute path** to `dist/index.js`, with escaped backslashes on Windows. A copy of this is in `claude_desktop_config.example.json`. Run `npm run build` first — the config points at compiled output, not `src/`. Then restart Claude Desktop fully (quit from the tray, not just close the window).

### Verify Claude discovered the tools

1. Open Claude Desktop → the tools/plug icon in the message composer → `surhires` should list **27 tools**.
2. Ask: *"Use get_server_diagnostics to check the Surhires server."* Expect `surhires_reachable: true` and a non-zero `pages_in_sitemap`.
3. If it does not appear, check the MCP log:
   - Windows: `%APPDATA%\Claude\logs\mcp-server-surhires.log`
   - macOS: `~/Library/Logs/Claude/mcp-server-surhires.log`

Before involving Claude, confirm the server works standalone:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/index.js
```

### Remote (Streamable HTTP)

```bash
npm run start:http
```

Stateless (a fresh server per request, sharing one page cache and outbound connection limit), bound to `127.0.0.1` with DNS-rebinding protection on. Abuse limits: browser `Origin` allowlist (403), a per-client rate limit (429), a 1 MB request body cap (413), malformed JSON answered with `400`/`-32700`, and a per-call page budget on fan-out tools. Outbound redirects are followed only within the Surhires origin. Connect it as a custom/remote MCP server at `http://127.0.0.1:3000/mcp`.

| Route | Method | Purpose |
|---|---|---|
| `/mcp` | POST | The MCP endpoint (JSON-RPC). A browser GET gets the landing page instead; an SSE GET gets 405, since a stateless server has no standalone stream |
| `/` | GET | Human-readable landing page: scope, endpoints, live tool list |
| `/health` | GET | Liveness JSON (`/healthz` kept as an alias) |
| `/version` | GET | `{"name","version","endpoint","transport"}` |
| `/.well-known/mcp.json` | GET | Discovery document: transport, auth (none), tool count (`tools/list` owns the names). Sent with `Access-Control-Allow-Origin: *` |

### Registry manifest

`server.json` describes the remote endpoint for the MCP registry under the DNS-verified namespace `com.surhires/mcp`. It is **not published** from this repository. Its `version` must equal `package.json`'s (the single version source, also used by `serverInfo` and the User-Agent); `npm run check:versions` checks that, and `npm test` runs it.

### Docker

The image serves the **HTTP transport**. Claude Desktop launches the stdio entry as a child process and does not need a container — this is for running the server as a reachable service.

```bash
docker build -t surhires-mcp .
```

```bash
docker run --rm -p 3000:3000 -e SURHIRES_CONTACT=you@example.com surhires-mcp
```

Multi-stage: dev dependencies are installed to compile TypeScript, then discarded. The final image carries `dist/`, production dependencies (`@modelcontextprotocol/sdk`, `zod`) and nothing else — no compiler, no tests. It runs as the non-root user `mcp` and declares a `HEALTHCHECK` against `/health`.

**Two container-specific settings matter:**

| Variable | Why |
|---|---|
| `MCP_HTTP_HOST` | Defaults to `0.0.0.0` in the image. Binding to `127.0.0.1` inside a container gives you a process that looks healthy and answers nothing from outside it |
| `TRUST_PROXY` | Behind a reverse proxy every caller arrives from the proxy's address and would share one rate-limit bucket. Set `1` there (and only there) |
| `MCP_PUBLIC_BASE_URL` | The public URL shown on the status page and in the discovery document; otherwise they point at `127.0.0.1` |
| `MCP_ALLOWED_HOSTS` | The transport rejects an unrecognised `Host` header (DNS-rebinding protection). Behind a proxy or a published name the Host is **not** localhost, so list it or every request gets **403**. Comma-separated; `*` disables the check, for a trusted network only |

```bash
docker run --rm -p 8080:3000 \
  -e MCP_ALLOWED_HOSTS=mcp.example.com,mcp.example.com:443 \
  -e MCP_PUBLIC_BASE_URL=https://mcp.example.com \
  -e TRUST_PROXY=1 \
  -e SURHIRES_CONTACT=you@example.com \
  surhires-mcp
```

No credentials are passed in because none exist. The runtime needs outbound HTTPS to `surhires.com` and nothing else.

Exposing it beyond localhost is your call and needs a reverse proxy terminating TLS and enforcing authentication. This server has no auth of its own — it holds no secrets and reads only public pages, but an open endpoint is still an open proxy for someone else's bandwidth.

### Pre-launch checklist: brand isolation

Surhires is a separate brand. Before the public host goes live, every surface a visitor or an agent can see must name Surhires only:

- [ ] The TLS certificate covers Surhires names only (no shared SANs naming other domains).
- [ ] The reverse proxy strips or neutralises `Server`, `Via` and `X-Powered-By`.
- [ ] Proxy error pages (502/503/504) carry no other brand or host.
- [ ] `SURHIRES_CONTACT` is a Surhires address, or left unset.
- [ ] The brand guard passes on the shipped files: `FORBIDDEN_BRANDS="<list>" npm run check:brands`. Keep the list in a CI secret or variable, never in this repository.
- [ ] The live audit passes with 0 FAIL on `C9.payloads`: `node audit-live-mcp.mjs https://<public host> --path /mcp --expect-host <public host> --forbid-brands "<list>"`.
- [ ] Registry metadata (`server.json`, if added) uses a Surhires namespace and omits any repository link that names another organisation.

---

## 5. Example prompts

Pricing and positioning:

- "What does Surhires cost per recruiter in India, and what's in each plan?"
- "Compare Surhires pricing across India, the US, the UK and Australia."
- "How does Surhires position itself against Bullhorn? Flag anything that's vendor spin."
- "Which competitors does Surhires publish a comparison page for?"

Capability and status — the useful ones:

- "Does Surhires have an API I can build against?" → `get_api_and_mcp_status`
- "Is the Naukri integration actually live, or just planned?" → `get_integration_status`
- "What's Surhires shipping now versus what's only planned?" → `get_roadmap`
- "List every Surhires integration, then tell me which ones say they're still in build."

Product research:

- "List all Surhires features and show me the AI ones."
- "How does Surhires handle resume parsing, and what are its stated limits?"
- "Search the Surhires site for anything about EEO compliance." *(add "search page text too" for deep mode)*
- "What does Surhires say about India's DPDP Act?"

Content:

- "What are the three most recent Surhires blog posts about?"
- "Search the Surhires blog for contractor classification."

What to expect when you ask for the impossible:

- "Search Surhires for Python developers in Bangalore." → the server explains no API exists; no fabricated candidates.
- "Post a job on Surhires." → no such tool, and `get_api_and_mcp_status` explains why.

---

## 6. Testing

```bash
npm test          # 108 offline tests against mocked HTTP
npm run typecheck
SURHIRES_LIVE=1 npm run test:live   # 10 tests against the real site
```

### What is actually verified

**Offline (108 tests, all passing).** Mocked at the `fetch` boundary with fixtures copied from live page structure.

- `extract.test.ts` — JSON-LD flattening, malformed-block tolerance, entity decoding, FAQ extraction, `AggregateOffer`/`Offer` parsing, breadcrumbs, table parsing, nav/footer/script exclusion, meta fallbacks.
- `client.test.ts` — market prefixing (including sitemap exemptions and no double-prefixing), the robots `/api/` refusal, cache hits, request coalescing, TTL=0, 404 mapping, 500 retry-then-succeed, 429 with `Retry-After`, timeouts, network failures, sitemap merge with one file down, malformed sitemap entries, concurrency ceiling.
- `validation.test.ts` — path normalisation, **refusal of other hosts including `app.surhires.com`**, traversal resolution, keyword matching, pagination edges, config defaults and rejections.
- `tools.test.ts` — all 27 tools end to end through a real MCP client over an in-memory transport: registration, pagination, truncation, market override, every error path, and two guard tests asserting no request ever went to `/api/` and no fake ATS tool is advertised.

**Live (10 tests, all passing on 2026-10-13).** Real GETs: sitemap size >100, pricing offers still present, feature page yields body + FAQs, comparison tables, `Organization` data, status pages still saying "not shipped", robots guard against the real origin, market currencies differing, deep search, blog dates.

One live test is a **tripwire**: if the status pages stop saying "planned / in development / no build", it fails on purpose — the signal that Surhires may have shipped an API and this server's scope should be revisited.

**Manual smoke tests run.** stdio: 27 tools listed, `get_pricing` returned live INR plans (3500/4500/8000). HTTP: `/health` OK, `initialize` and `tools/list` (27) over `POST /mcp`.

### Checklist for a fresh machine

1. `npm install` — no vulnerabilities reported
2. `npm run typecheck` — clean
3. `npm test` — 108 passing
4. `SURHIRES_LIVE=1 npm run test:live` — 10 passing (needs network)
5. stdio smoke test above — 27 tools
6. `npm run start:http` then `curl http://127.0.0.1:3000/health`
7. Claude Desktop shows 27 tools; `get_server_diagnostics` reports reachable

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tools absent in Claude Desktop | Config path wrong, or not rebuilt | Absolute path to `dist/index.js`, escaped backslashes; `npm run build`; fully quit and reopen Claude |
| `Cannot find module .../dist/index.js` | Never built | `npm run build` |
| Server starts then dies immediately | Bad env var | Check the MCP log — `loadConfig` names the offending variable |
| `could not extract any plan offers` | Pricing page markup changed | `get_page` on `/pricing` to inspect; the extractor needs updating |
| Everything times out | Network or proxy | `get_server_diagnostics`; raise `SURHIRES_TIMEOUT_MS` |
| HTTP 429 from Surhires | Too many parallel reads | Lower `SURHIRES_MAX_CONCURRENCY`, raise `SURHIRES_CACHE_TTL_MS` |
| Results feel stale | Page cache | Entries expire after `SURHIRES_CACHE_TTL_MS` (15 min); restart the process to drop them sooner |
| `robots.txt disallows` | You asked for `/api/*` | Working as intended; that surface is off-limits |
| `only reads surhires.com` | Off-origin URL passed | Pass a site path |
| Deep search finds nothing | Scan budget | Raise `deep_max_pages`, or pass `section` |
| Tests fail on `.ts` imports | Tests import compiled output | `npm test` builds first; don't run `node --test` alone |

---

## 7. Project structure

```
surhires-mcp/
├── src/
│   ├── index.ts                     # stdio entry (Claude Desktop)
│   ├── http.ts                      # Streamable HTTP entry (remote)
│   ├── server.ts                    # server assembly, scope instructions
│   ├── config.ts                    # env parsing/validation (Zod)
│   ├── clients/
│   │   ├── surhires-client.ts       # GET-only: cache, retry, concurrency, robots guard, sitemaps
│   │   └── extract.ts               # JSON-LD + markup extraction
│   ├── tools/
│   │   ├── shared.ts                # slug resolution, ranking, page presentation
│   │   ├── pages.ts                 # list_site_pages, get_page, search_site, get_page_faqs
│   │   ├── catalog.ts               # features, integrations, solutions, free tools
│   │   ├── pricing.ts               # pricing, market comparison, competitor comparisons
│   │   ├── content.ts               # blog, resources, changelog, roadmap
│   │   └── company.ts               # company, API status, integration status, trust, diagnostics
│   └── utils/
│       ├── errors.ts                # typed errors with actionable hints
│       ├── logger.ts                # stderr JSON logging with redaction
│       └── validation.ts            # shared Zod args, path normalisation, ranking, pagination
├── tests/                           # fixtures, mock fetch, 4 offline suites, 1 live suite
├── .env.example
├── claude_desktop_config.example.json
├── package.json
├── tsconfig.json
└── README.md
```

### Design decisions worth knowing

- **Structured data over scraping.** Every page carries schema.org JSON-LD; the extractor reads that first and falls back to markup only for prose. Far more stable than CSS selectors.
- **The sitemap is the index.** No hardcoded page lists, so the catalogue cannot drift, and a slug is resolved against what is actually published rather than string-built — a tool cannot invent a URL.
- **Robots compliance is enforced in code,** before any request, and checked both before and after market prefixing so `/api/x` cannot slip through as `/in/api/x`. There is a test for exactly that.
- **Off-origin refusal.** `normalisePath` rejects any URL not on the configured origin, including `app.surhires.com`, so a crafted argument cannot make this an open proxy.
- **Tools state their own epistemics.** Comparison pages return a `bias_note`; pricing returns `caveats` including that Surhires calls its own prices provisional; `get_integration_status` exists precisely because a published page does not mean a working connector.
- **Logs never touch stdout** (reserved for MCP framing) and redact any field whose key looks like a secret — defensive groundwork for a future authenticated client.

---

## 8. Missing API capabilities and access requirements

What is unavailable today, and what would unblock it.

### Blocked entirely — no authorized interface exists

| Capability | Blocker | What would unblock it |
|---|---|---|
| Candidate search / profiles | No public API; robots disallows `/api/` | A documented, authenticated candidate endpoint |
| Job listing CRUD | Same | A documented jobs API with write scopes |
| Applications: submit, status, list | Same | A documented applications API |
| Pipeline read/manage | Same | A documented pipeline API |
| My profile / account | Same | An authenticated account endpoint |
| Resume parsing via API | Feature exists in-product, no API | A parsing endpoint accepting an upload |
| Webhooks / event subscriptions | Nothing published | Published webhook docs + signing secret |
| Zapier-mediated access | App "in development", "not usable today" | Zapier app ships; invite + developer docs |
| Authenticated (tenant-data) MCP surface | No tenant API | A documented, authenticated API |

### Access requirements if Surhires does ship an API

1. **Documentation** — OpenAPI spec or equivalent; without it, any client is guesswork.
2. **Auth mechanism** — OAuth 2.0 (preferred: scoped, revocable, per-user) or scoped API keys. `/mcp-server` says the server would "authenticate as a person" and inherit tenant/role/field permissions, which points at OAuth.
3. **Scopes** — read and write separated, as that page describes.
4. **A tenant and credentials** you are authorized to use.
5. **Rate limits** — the Zapier page mentions a per-tenant limit but publishes no figures.
6. **Sandbox tenant** — so write paths can be tested without touching production records.
7. **Written confirmation** that programmatic access is permitted under your agreement; `/api/` being robots-disallowed signals that automated access is not currently invited.

### Not pursued, on purpose

**Browser automation against `app.surhires.com`** would technically reach tenant data. It was not built: it drives an authenticated session, `/api/` is robots-disallowed, it would likely conflict with the Terms, and it breaks on any UI change. If you own the tenant and are authorized, that is a conversation to have explicitly — not a default.

### If an API appears

1. Run `get_api_and_mcp_status` — it reads the live pages, so it answers for itself.
2. The live tripwire test will start failing, which is the intended signal.
3. Add an authenticated client beside `src/clients/surhires-client.ts`; register its tools in `src/tools/`. The transports, config, error taxonomy, logging and test harness all carry over unchanged.

---

## Scope and good citizenship

Read-only GETs of public pages. No credentials held, no authenticated system touched, no CAPTCHA or access control bypassed, nothing written to Surhires. Requests are capped at 4 concurrent, cached for 15 minutes, retried with backoff, and sent with an identifying User-Agent carrying your contact address. `robots.txt` is honoured in code.

Content belongs to Surhires / Soor LLC. This is the official Surhires MCP server for public website content. Treat vendor-authored comparison pages as marketing, and confirm anything commercially load-bearing with Surhires directly.
