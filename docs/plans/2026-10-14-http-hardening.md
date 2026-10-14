# Plan: rate limiting and abuse hardening for the public HTTP endpoint

- **Severity:** P0 (an anonymous endpoint that fans out to the origin)
- **Effort:** M

## Finding

| # | Issue | Evidence |
|---|---|---|
| a | No rate limit on `POST /mcp`. Anyone can drive unlimited origin fetches. | `src/http.ts:198-250` has no limiter |
| b | `search_site deep=true` fetches up to 60 pages per call (`deep_max_pages` max 60). `search_blog` fetches up to 40. Every HTTP caller is anonymous. | `src/tools/pages.ts:120-126, 160-163`; `src/tools/content.ts:159, 181-185` |
| c | Outbound fetch uses `redirect: "follow"` with no final-host check. A redirect from the origin, or from anything able to inject one, takes the server to any host, including the robots-disallowed `/api/`. | `src/clients/surhires-client.ts:153` |
| d | There is no Origin allowlist. A Host check (DNS-rebinding protection) exists, but a browser on any site can POST cross-origin. | `src/http.ts:219-231` (`allowedOrigins` unset) |
| e | Unexpected errors echo `error.message` to the caller. | `src/utils/errors.ts:104` (`Unexpected failure: ${error.message}`) |
| f | The body cap is 4 MB. JSON-RPC requests here are a few hundred bytes. | `src/http.ts:22` |

Measured on `main` (248f38d) with a local `dist/http.js`:
- A POST to `/mcp` with `Origin: http://evil.example` returned **200** with the full `tools/list`.
- The audit script gives 4 fail / 6 warn / 12 pass. Its "1 write tool callable ... rate-limited?" WARN refers to `get_server_diagnostics`.

## Proposed fix

1. **Rate limit (a).** New `src/utils/rate-limit.ts`:
   - `RateLimiter(limit, windowMs=60s)`: a fixed window per key, swept when the map exceeds 1000 keys. `hit(key)` returns the seconds to wait, or 0.
   - `clientKey(req, trustProxy)`: the socket address by default. When `TRUST_PROXY=1`, use the right-most `X-Forwarded-For` hop (the one our own proxy adds, which a client cannot forge).
   - In `src/http.ts`, check the limiter before `buildServer`. Over the limit, return 429 with `Retry-After` and a JSON-RPC error body.
   - Config: `MCP_RATE_LIMIT_PER_MIN` (default 60; 0 disables) and `TRUST_PROXY`.
2. **Deep-search cap (b).**
   - Add `deepPageCap?: number` to `ToolContext` and `BuildOptions`.
   - New helper `capDeepPages(ctx, requested)` in `src/tools/shared.ts`. Apply it in `search_site` and `search_blog`.
   - When the cap applies, add `deep_max_pages_capped_to` / `deep_max_posts_capped_to` to the result.
   - `http.ts` passes `MCP_HTTP_DEEP_MAX_PAGES` (default 10). Stdio keeps the per-tool maximums.
3. **Redirects (c).**
   - Use `redirect: "manual"` and follow 301/302/303/307/308 by hand, up to 5 hops.
   - Each hop must keep the configured origin's protocol and host. Otherwise throw `SurhiresError("upstream", "redirected off the Surhires origin; not followed")`.
   - Run `assertAllowed()` on every hop's path, both with and without the market prefix.
   - Widen the `FetchLike` `redirect` type to `"follow" | "manual"`.
4. **Origin allowlist (d).**
   - Pass `allowedOrigins` to `StreamableHTTPServerTransport`. SDK 1.32.1 supports it alongside `enableDnsRebindingProtection`.
   - Defaults: `http://localhost:<port>`, `http://127.0.0.1:<port>` and `https://mcp.surhires.com`, plus `MCP_ALLOWED_ORIGINS`. `*` means any Origin.
   - Requests with no Origin header (non-browser MCP clients) are unaffected.
   - Also add `mcp.surhires.com` and `mcp.surhires.com:443` to the default `allowedHosts`.
5. **Generic errors (e).** In `asToolResult`, return the `SurhiresError` text as today. Any other error gets "Unexpected internal error while handling this request..." and the detail goes to stderr.
6. **Body cap (f).** Cap the body at 1 MB. Return 413 with a JSON-RPC error, rather than today's 500.

Document every new env var in the README (container section) and `.env.example`.

## Tests to add

- `RateLimiter` unit tests with an injected clock:
  - The 61st hit in a window returns >0, and a new window resets.
  - Limit 0 disables limiting.
- `clientKey`: the socket address without `TRUST_PROXY`; the right-most XFF hop with it.
- Mock-fetch outcome `redirect`:
  - A same-host redirect is followed.
  - An off-host redirect is refused, and no request goes to the other host.
  - A redirect to `/api/x` is refused.
- An in-memory server with `deepPageCap: 3`: `search_site deep=true deep_max_pages=60` fetches at most 3 pages and reports the cap.
- Spawned `dist/http.js`:
  - A bad Origin gets 403.
  - No Origin, or an allowed Origin, gets 200.
  - With `MCP_RATE_LIMIT_PER_MIN=2`, the 3rd POST gets 429 with `Retry-After`.
  - A 2 MB body gets 413.
- `asToolResult`: a plain `Error("secret internals")` is not echoed.

## Risks / rollout

- Behind Cloudflare and Apache, set `TRUST_PROXY=1`. Without it, every caller shares the proxy's IP and one bucket. With it set but no proxy in front, a caller can choose its own key.
- 60/min may be tight for agents that page through lists. Watch the 429s after launch.
- Manual redirects: Next.js 307s (e.g. trailing slash) still work because they stay on the same host.
- **Founder decision:** is `https://mcp.surhires.com` the final public host? It is also used by the registry plan.

## Not checked

- The live surhires.com redirect behaviour (the sandbox egress proxy blocks it).
- Cloudflare's own rate limiting, if any.
