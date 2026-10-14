# Plan: record tool usage without arguments

- **Severity:** P2 (business insight)
- **Effort:** S

## Finding

There is no record of which tools agents call, from which client, or how long they take. `rg -n "latency|clientInfo|usage" src` finds nothing. The logger (`src/utils/logger.ts`) only records server build, fetches (debug) and failures. Without usage data nobody can tell whether the server drives any traffic, which tools matter, or which fail.

## Proposed fix

1. In `asToolResult` (`src/utils/errors.ts`), wrap each call with a timer and emit one `info` log line: `{ msg: "tool_call", tool, ok, ms, error_kind? }`.
2. Pass the tool name in at registration (the `register` wrapper in `src/server.ts` already sees it).
3. Client name and version: read from the `initialize` request (`server.server.getClientVersion()`) and add `client` to the line.
4. **Never log arguments or results.** Queries can carry a user's words.
5. Optional, later: a `/metrics` counter endpoint behind an env flag.

## Tests to add

- Capture stderr in an in-memory test: one `tool_call` line per call, with `tool`, `ok`, `ms`, and no `arguments` key.
- A failing call logs `ok:false` and `error_kind`.

## Risks / founder decisions

- Logs go to stderr only; where they are shipped (and retention) is a deployment decision.
- No founder decision on the code itself.

## Not checked

- Log pipeline in production (not deployed from here).
