# Plan: advertise the public endpoint from config, not localhost

- **Severity:** P2 (discovery quality)
- **Effort:** S

## Finding

Measured on `main` (248f38d), local `dist/http.js`, `audit-live-mcp.mjs`:
- **WARN `X.discovery_url`**: "status page links to a localhost URL". The "Try it" block on `/` is hard-coded to `http://127.0.0.1:${config.port}/mcp` (`src/http.ts:125`). Deployed behind `mcp.surhires.com`, every visitor would be told to curl their own machine.
- **WARN `X.version`**: `/version` returns only `{name, version}` (`src/http.ts:171-174`), with no endpoint path.
- `/.well-known/mcp.json` gives a relative `url: "/mcp"` (`src/http.ts:184`). Not wrong, but an absolute URL from config is what registries and inspectors expect.

## Proposed fix

1. `src/config.ts`: add `publicBaseUrl` (env `MCP_PUBLIC_BASE_URL`, optional, validated as an `https://` URL; unset locally).
2. `src/http.ts`:
   - status page "Try it": use `${publicBaseUrl ?? "http://127.0.0.1:" + port}/mcp`;
   - `/version`: add `endpoint: "/mcp"` and `transport: "streamable-http"`;
   - manifest: `transport.url` absolute when `publicBaseUrl` is set.
   Never derive it from `Host` or `X-Forwarded-Host` (a caller could set those).
3. Dockerfile and README: document `MCP_PUBLIC_BASE_URL=https://mcp.surhires.com` for deployment.

## Tests to add

- Spawned server with `MCP_PUBLIC_BASE_URL=https://mcp.example.test`: `/` contains that URL and no `127.0.0.1`; manifest `transport.url` is absolute.
- With `Host: evil.example` (allowed via `MCP_ALLOWED_HOSTS=*`), the advertised URL is unchanged.
- `/version` has `endpoint`.

## Risks / founder decisions

- Depends on the public host decision raised in PRs #4 and #7 (`mcp.surhires.com`).

## Not checked

- The deployed host (none exists yet as far as this repo shows).
