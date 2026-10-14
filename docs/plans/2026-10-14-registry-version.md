# Plan: registry manifest (server.json) and a single version source

- **Severity:** P2 (distribution; version drift)
- **Effort:** S

## Finding

The version `0.1.0` is hard-coded in three places, which will drift:
- `package.json:3`
- `src/server.ts:13` (`SERVER_VERSION`, served by `/version`, `/health`, `/.well-known/mcp.json` and `initialize`)
- `src/config.ts:58` (the User-Agent string `surhires-mcp/0.1.0`)

There is no `server.json`, so the server cannot be submitted to the MCP registry. There is also no `websiteUrl` or icon metadata anywhere. The audit (`audit-live-mcp.mjs`, endpoint path changed from `/sse` to `/mcp`) PASSes `/version` on main as `surhires-mcp v0.1.0`. It cannot detect drift.

## Proposed fix

1. **New `src/version.ts`.** Read `package.json` once at startup with `createRequire(import.meta.url)("../package.json")`, which resolves from `dist/`. Export `SERVER_VERSION`.
   - The Dockerfile already copies `package.json` into the runtime image (`COPY --chown=mcp:nodejs package.json ./`), and `files` in `package.json` publishes it with npm.
   - `src/server.ts` re-exports it. `src/config.ts` builds the User-Agent from it.
2. **New `server.json`**, shaped like the HelloGrowthCRM one:
   - `$schema`: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
   - `name`: `io.github.merulocal/surhires-mcp`
   - `description`, `status: "active"`
   - `version`: from `package.json`
   - `repository`: `{ url: "https://github.com/MeruLocal/surhireswebsite_MCP", source: "github" }`
   - `websiteUrl`: `https://surhires.com`
   - `remotes`: `[{ type: "streamable-http", url: "https://mcp.surhires.com/mcp" }]`
   - `icons`: Surhires' logo URL. Use the `logo` field the site already publishes in its Organization JSON-LD; do not invent a path.
   - Add `packages[]` (npm, stdio, env vars from `.env.example`) only if the package is published. Today `"private": true`, so omit it.
3. **New `scripts/check-versions.mjs`.** Fail when `server.json.version` ≠ `package.json.version`. Wire it into `npm test` (or CI).
4. Optionally add `websiteUrl` and `icons` to `/.well-known/mcp.json`, and to `McpServer` `serverInfo` (`websiteUrl` / `icons` are supported by SDK 1.32 `Implementation`).

## Tests to add

- `SERVER_VERSION === package.json.version`.
- The `serverInfo.version` returned by `initialize` (in-memory client) equals the package version.
- The User-Agent contains `surhires-mcp/<package version>`.
- `check-versions.mjs` exits 0 on the repo and 1 on a mismatched temp copy.

## Risks / founder decisions

- **Founder decision:** the registry `name` namespace (`io.github.merulocal/...` vs a DNS-verified `com.surhires/...`). The latter needs a DNS TXT record on surhires.com.
- **Founder decision:** confirm `https://mcp.surhires.com/mcp` is the public endpoint (also used by the HTTP hardening plan). It is not deployed today as far as this repo shows.
- Icon: needs a stable public HTTPS URL, ideally 64–512 px PNG/SVG.

## Not checked

- Whether `mcp.surhires.com` resolves (the sandbox egress proxy blocks it).
- Registry submission itself.
