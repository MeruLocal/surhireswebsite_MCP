# Plan: expose pricing and plan-choice as MCP resources and a prompt

- **Severity:** P2 (nice to have)
- **Effort:** S

## Finding

The server declares tools only (`capabilities: { tools: {} }`, `src/server.ts:56`). There are no resources and no prompts, so clients that surface resources (pinned context) or prompts (slash commands) show nothing for Surhires.

## Proposed fix

1. Resources (read-only, generated from the same client and cache, never hard-coded):
   - `surhires://pricing/{market}`: the `get_pricing` result for one market;
   - `surhires://features`: the `list_features` result.
2. One prompt, `recommend_plan`, with arguments `team_size` and `market`. It tells the model to call `get_pricing` and `list_features`, quote prices as published by the site, and finish with the pricing page link (and `get_started` once PR #6 lands).
3. List both in the README.

## Tests to add

- `resources/list` contains both URIs; `resources/read surhires://pricing/in` returns the fixture plans.
- `prompts/get recommend_plan` names `get_pricing` in its message.

## Risks / founder decisions

- The prompt must not state any price or trial term itself; it only routes to the tools.
- Depends loosely on PR #6 for the call-to-action link. No founder decision.

## Not checked

- Client support for resources and prompts beyond the SDK's in-memory client.
