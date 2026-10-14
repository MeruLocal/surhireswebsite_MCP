# Plan: keep the server's public footprint brand-isolated

- **Severity:** P0 (identity; founder rule of 2026-10-14)
- **Effort:** S (mostly settings and metadata, decided by the founder)

## Finding

Founder decision, 2026-10-14: Surhires is brand-isolated because of differential pricing. No visitor- or agent-visible surface may name the operating group or its other products, whether as a name, a host or a link.

What the server itself emits is clean. Measured on `main` (248f38d) with `audit-live-mcp.mjs --forbid-brands <the five isolated names>` against a local `dist/http.js` (fake origin serving `tests/fixtures.ts`):
- **PASS** `C9.payloads`: none of the forbidden names appear in `initialize`, `tools/list`, instructions, `/`, `/.well-known/mcp.json` or the `get_pricing` output.
- `rg -ni` for the forbidden names over `src`, `tests`, `README.md`, `package.json`, `Dockerfile` and `.env.example`: no hits.

The leaks are around the server, not in it:

| # | Surface | Today |
|---|---|---|
| a | GitHub repository | **public**, under the operating group's GitHub org. The org name is in every clone URL, PR link and commit. Anyone who finds the server can see who runs it. |
| b | Registry metadata (open plan in PR #7) | proposes `name: io.github.<org>/surhires-mcp` and `repository.url` pointing at this org. Both are shown publicly by the MCP registry and its mirrors. A correction is pushed to PR #7. |
| c | `User-Agent` sent to surhires.com | carries `SURHIRES_CONTACT` (`src/config.ts:58`). Harmless today (`unspecified`), but a group email set there would reach any proxy or log viewer. |
| d | Deployment | the public host (`mcp.surhires.com` in PRs #4/#7), its TLS certificate SANs, `Server`/`Via` headers and proxy error pages must not reveal a shared host or the group's other domains. Not checkable from the sandbox. |

## Proposed fix (no code)

1. **Repository (a): founder decision.** Choose one:
   - make this repository private (simplest; nothing is published from it yet, `package.json` is `"private": true`); or
   - transfer it to a neutral or Surhires-named GitHub org before any registry or npm submission.
   GitHub redirects old URLs after a transfer, so existing PR links keep working.
2. **Registry (b).** Use the DNS-verified namespace `com.surhires/mcp` (needs a TXT record on surhires.com). Omit `repository` unless the repo is in a Surhires-named org.
3. **Contact (c).** Document in `.env.example` and the README that `SURHIRES_CONTACT` must be a Surhires address.
4. **Deployment (d).** Add a pre-launch checklist to the README:
   - the certificate covers only Surhires names;
   - the proxy strips or neutralises `Server`/`Via`/`X-Powered-By`;
   - proxy error pages carry no other brand;
   - run `audit-live-mcp.mjs https://mcp.surhires.com --expect-host mcp.surhires.com --forbid-brands <list>` and require 0 FAIL on `C9.payloads`.
5. **CI guard.** Once CI exists (PR #8), add a step that greps the shipped files (`src`, `README.md`, `package.json`, `server.json`, `Dockerfile`, `.env.example`) for the forbidden names and fails on a hit. The list lives in a CI secret or variable, not in the repo, so the guard itself does not publish the names.

## Tests to add

- The CI grep guard above (fails on a planted name in a temp copy).
- The live audit command in step 4 as a launch gate.

## Risks / founder decisions

- **Founder decision:** private repository or transfer to which org.
- **Founder decision:** registry namespace (`com.surhires/...` recommended).
- PR descriptions in this repo carry a hidden attribution comment naming the GitHub account. It adds nothing beyond the URL, but goes away only with (a).
- Legal owner names (Soor LLC) are out of scope and unchanged.

## Not checked

- Live `mcp.surhires.com`: DNS, certificate, headers (sandbox egress blocks it).
- Whether search engines have already indexed this repository.
