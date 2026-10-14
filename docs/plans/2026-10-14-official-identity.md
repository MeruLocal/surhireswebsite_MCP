# Plan: present the server as the official Surhires MCP

- **Severity:** P1 (brand/positioning; every connecting agent is told the opposite)
- **Effort:** S

## Finding

The server disclaims being Surhires' own server. It also tells agents that the real Surhires MCP server does not exist yet.

| Where | Text today |
|---|---|
| `src/http.ts:136-137` (status page footer) | "Content belongs to Surhires / Soor LLC; this is an unofficial client, not affiliated with or endorsed by Surhires." |
| `src/http.ts:114-119` (status page) | "Its own pages describe the official Surhires MCP server as planned rather than shipping." |
| `src/server.ts:21-25` (`INSTRUCTIONS`, sent to every client on `initialize`) | "...and its own site describes its MCP server as planned with no build under way." |
| `src/tools/company.ts:64` (`get_api_and_mcp_status` description) | "...published ... no MCP server, and described its own MCP server as planned..." |
| `src/tools/company.ts:81` (hard-coded `summary` line) | "Surhires' own /mcp-server page described its MCP server as planned, not shipping." |
| `README.md:3`, `README.md:33`, `README.md:404` | "An MCP server for", "no shipped MCP server", "This is an unofficial client, not affiliated with or endorsed by Surhires." |
| `README.md:376` (§8 table, row "Official MCP server") *(added 2026-10-14 re-audit)* | "Surhires ships it — then prefer theirs over this": tells readers this server is a stand-in to be replaced |

Measured: on `main` (248f38d), `GET /` on a local `dist/http.js` returns the "unofficial client" footer.

Re-audit 2026-10-14 (new `audit-live-mcp.mjs`, `--path /mcp`): **FAIL `X.identity`** "status page says 'unofficial', 'not affiliated'". The instructions/tools/serverInfo identity check PASSes, so the status page and README are the remaining surfaces.

## Proposed fix

Wording only. There is no behaviour change.

1. `src/http.ts` `sendStatusPage()`:
   - Change the title and h1 to "Surhires MCP Server".
   - Replace the "planned" paragraph with: "This is the official Surhires MCP server for public product knowledge. It reads the published website only..."
   - Keep "Content belongs to Surhires / Soor LLC." and drop the rest of that sentence.
2. `src/http.ts` `/.well-known/mcp.json` description: start it with "Official Surhires MCP server: read-only access to the public Surhires website...".
3. `src/server.ts` `INSTRUCTIONS`:
   - Open with "This is the official Surhires MCP server."
   - Replace the "planned with no build under way" clause with "that data lives behind a login at app.surhires.com and no public API for it is published".
   - Keep the scope bullets ("NO credentials", "CANNOT search candidates"). The existing test at `tests/tools.test.ts:91` asserts them.
4. `src/tools/company.ts` `get_api_and_mcp_status`:
   - Description: "no REST API, API keys or developer docs for tenant data; this server is the official Surhires MCP server for public website content".
   - Replace the hard-coded "planned" summary line to match.
5. `README.md`:
   - Line 3: "The official MCP server for Surhires".
   - Line 33: "no authenticated MCP surface for tenant data".
   - Line 404: "This is the official Surhires MCP server for public website content."
   - Line 376: replace the "Official MCP server" row with one for the *authenticated* (tenant-data) MCP surface: blocker "no tenant API", unblocked by "a documented, authenticated API".
   - The Soor LLC wording stays unchanged.

## Tests to add

New `tests/identity.test.ts` (and add it to the `test` script):
- Over an in-memory client: the instructions match `/official Surhires MCP server/`, contain no "planned", and neither the instructions nor any tool description matches `/unofficial|not affiliated|endorsed by/i`.
- Spawn `dist/http.js` on a random local port:
  - `GET /` contains "official" and "Content belongs to Surhires / Soor LLC", and has no "unofficial" wording.
  - `/.well-known/mcp.json` `description` starts with "Official Surhires MCP server".

A prototype of these tests passed (111/111) before the change of approach to plans only. That prototype was discarded.

## Risks / founder decisions

- **Website contradiction (founder decision):** per the README's 2026-10-13 check, surhires.com `/mcp-server` and `/whats-shipping` still say the Surhires MCP server is "planned, not shipping". `get_api_and_mcp_status` returns that page text live, so agents will see both claims until the website copy changes. That fix belongs in the website repo, not here.
- `tests/live.test.ts:91-101` is a tripwire that expects the "planned" wording on the live site. Leave it until the website changes, then update it in the same PR.
- The Soor LLC name and all prices are out of scope and unchanged.

## Not checked

- The live surhires.com pages: the sandbox egress proxy blocks them.
