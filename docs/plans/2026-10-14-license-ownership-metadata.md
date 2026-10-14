# Plan: license file and ownership metadata

- **Severity:** P1 (ownership; blocks any publication)
- **Effort:** S

## Finding

- `package.json` declares `"license": "MIT"`, but the repository has **no `LICENSE` file**. MIT requires the copyright notice to travel with the code.
- `package.json` has no `author`, `homepage` or `repository`. Registries and scanners fall back to guesses, or to the GitHub org that hosts the repo.
- `npm view surhires-mcp`: `https://registry.npmjs.org/surhires-mcp` returns **404**. Fine while `"private": true`, but anyone can claim the name first.

## Proposed fix

1. Add `LICENSE` (MIT text) with the copyright holder **the founder names**. Do not guess the legal owner.
2. `package.json`: `homepage: "https://surhires.com"`, `author` set to the founder-approved owner name, `repository` only if the repo moves to a Surhires-named org (see the brand-isolation plan).
3. Decide on the npm name: either publish (then reserve `surhires-mcp` from a Surhires-named npm account) or leave it private and say so in the README.

## Tests to add

- CI (PR #8): fail if `LICENSE` is missing or `package.json` lacks `homepage`.

## Risks / founder decisions

- **Founder decision:** the copyright holder and `author` string. This plan does not change or add any legal owner name.
- **Founder decision:** publish to npm or not, and from which account (must not reveal the operating group).

## Not checked

- npm account ownership and any trademark questions.
