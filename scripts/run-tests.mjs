#!/usr/bin/env node
/**
 * Runs the offline test suite: every tests/*.test.ts except the live tests,
 * so the file list lives in one place and a new test file is picked up
 * without editing package.json. Extra arguments (e.g.
 * --experimental-test-coverage) are passed through to `node --test`.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "tests"))
  .filter((f) => f.endsWith(".test.ts") && f !== "live.test.ts")
  .sort()
  .map((f) => join("tests", f));

// Node >= 22.18 strips TypeScript types by default; older 22.x needs the flag.
const [major, minor] = process.versions.node.split(".").map(Number);
const strip = major === 22 && minor < 18 ? ["--experimental-strip-types"] : [];

const result = spawnSync(process.execPath, [...strip, "--test", ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
