/** Guards for package metadata and example files (fail in CI, not in review). */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(repo, f), "utf8");

describe("package.json", () => {
  test("has no duplicate script keys (JSON.parse would hide them)", () => {
    const raw = read("package.json");
    const block = raw.slice(raw.indexOf('"scripts"'), raw.indexOf("}", raw.indexOf('"scripts"')));
    const keys = [...block.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]).filter((k) => k !== "scripts");
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dupes, []);
  });

  test("declares a homepage, and a LICENSE file ships with the code", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.homepage, "package.json needs a homepage");
    assert.ok(existsSync(join(repo, "LICENSE")), "LICENSE is missing");
    assert.match(read("LICENSE"), new RegExp(`^${pkg.license} License`));
  });

  test("the offline test runner excludes live tests", () => {
    assert.match(read("scripts/run-tests.mjs"), /live\.test\.ts/);
  });
});

describe("example files", () => {
  test("claude_desktop_config.example.json carries no personal path", () => {
    const text = read("claude_desktop_config.example.json");
    assert.doesNotMatch(text, /Users\\\\|\/Users\/|\/home\//);
    JSON.parse(text);
  });
});
