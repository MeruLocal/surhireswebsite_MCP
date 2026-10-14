# Plan: return a JSON-RPC parse error for malformed request bodies

- **Severity:** P2 (protocol correctness)
- **Effort:** S

## Finding

`src/http.ts:34` calls `JSON.parse` on the raw body. A malformed body throws, the catch at `src/http.ts:241-249` logs it and replies **HTTP 500 with code -32603** ("Internal server error").

Measured on `main` (248f38d), local `dist/http.js`:
- `audit-live-mcp.mjs`: **WARN `C1.parse_error`**: "malformed JSON → HTTP 500, code -32603 (expected -32700 / 400)".
- `curl -X POST /mcp -d '{bad'` returned `HTTP/1.1 500` and `{"jsonrpc":"2.0","error":{"code":-32603,...},"id":null}`.

A client cannot tell its own bad request from a server fault, and 500s pollute uptime monitoring.

## Proposed fix

In `src/http.ts`:
1. Split `readJsonBody` into read and parse. On a `SyntaxError` from `JSON.parse`, reply **400** with `{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}`.
2. Keep 500/-32603 for real internal failures (generic text, detail only in the log).
3. The body-size error is handled by PR #4 (413). If both land, PR #4's branch should merge first; this change touches the same function.

## Tests to add

- Spawned `dist/http.js`: a `{bad` body gets 400 and code -32700.
- A valid `tools/list` still gets 200.

## Risks

- None for well-formed clients. No founder decision.

## Not checked

- Behaviour behind the production proxy (not deployed from here).
