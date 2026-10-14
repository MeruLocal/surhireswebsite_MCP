# Plan: CI workflow, npm script fixes and a scrubbed example config

- **Severity:** P2 (hygiene; one privacy leak in an example file)
- **Effort:** S

## Finding

1. **No CI.** There is no `.github/` directory, so nothing runs typecheck, build or tests on a PR. On `main` (248f38d), `npm ci`, `npm run typecheck` and `npm test` pass locally: **108/108**.
2. **Duplicate `test:coverage` key** in `package.json` (lines 27 and 30, identical). JSON parsers keep the last one silently, and some tools warn or reject.
3. **`test:only`** is `node --test tests/`. It runs every test file, including `tests/live.test.ts`, which is skipped only when `SURHIRES_LIVE` is unset. It also runs against stale or missing `dist/`, because it does not build. It should exclude live tests explicitly.
4. **A personal Windows path** in `claude_desktop_config.example.json`: `"C:\\Users\\Hp\\Desktop\\Surhires_MCP\\dist\\index.js"` leaks a local username and machine layout.

## Proposed fix

1. **New `.github/workflows/ci.yml`:**
   - Triggers: `push` and `pull_request`; `ubuntu-latest`; `actions/setup-node` with `node-version: 22` and `cache: npm`.
   - Steps: `npm ci`, `npm run typecheck`, `npm run build`, `npm test`.
   - *(Added 2026-10-14 re-audit, skill D4)* `npm audit --omit=dev --audit-level=high` (0 vulnerabilities on main today), and, once PRs #7 and #9 land, `node scripts/check-versions.mjs` and the brand-isolation grep.
   - Permissions: `contents: read`.
   - No live tests and no secrets.
2. **`package.json` scripts:**
   - Delete the second `test:coverage` entry.
   - `test:only`: `node --test tests/extract.test.ts tests/validation.test.ts tests/client.test.ts tests/tools.test.ts`, i.e. the same list as `test` but without the build.
   - Optionally, keep the file list in one place, so the three scripts cannot drift apart.
   - Note: `node --test` with explicit `.ts` files relies on Node ≥22.18 type stripping. CI pins Node 22, so `engines` should become `>=22.18`, or pass `--experimental-strip-types`.
3. **`claude_desktop_config.example.json`:** use the placeholder `"/absolute/path/to/surhires-mcp/dist/index.js"`. Add a one-line README note on Windows path escaping.

## Tests to add

- The CI workflow itself is the test. The first run on the PR must pass.
- Add a cheap guard test (or CI step): `node -e` reads `package.json` and asserts no duplicate keys. It reads the raw file because `JSON.parse` hides duplicates, so it must scan the scripts block text.
- Add a guard that `claude_desktop_config.example.json` contains no `Users\\` / `/home/` path.

## Risks / rollout

- Each code PR from the other plans that adds a test file also edits the `test` script line. Merge order matters; trivial rebase conflicts are expected.
- `engines` bump: anyone on Node 20 would need to upgrade. Today, `npm test` already fails on Node 20 without type stripping, so this documents reality.
- There are no founder decisions needed.

## Not checked

- GitHub Actions minutes or org policy on Actions in this repo.
