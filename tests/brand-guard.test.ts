/**
 * The brand-isolation guard must fail on a planted name and pass on a clean
 * tree. Uses obviously fake names; the real list lives outside the repository.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const script = join(repo, "scripts", "check-brands.mjs");

const run = (root: string, names: string | undefined) =>
  spawnSync(process.execPath, [script, root], {
    env: { ...process.env, FORBIDDEN_BRANDS: names ?? "" },
    encoding: "utf8",
  });

function tempCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "brand-guard-"));
  for (const f of ["src", "README.md", "package.json", "Dockerfile", ".env.example"]) {
    cpSync(join(repo, f), join(dir, f), { recursive: true });
  }
  return dir;
}

describe("check-brands guard", () => {
  test("passes on the repository with a fake forbidden list", () => {
    // Assembled at runtime so this file (now itself scanned) never contains the names.
    const names = [["no", "such", "name", "one"].join("-"), ["no", "such", "name", "two"].join("-")];
    const r = run(repo, names.join(","));
    assert.equal(r.status, 0, r.stderr);
  });

  test("fails on a name planted in a shipped file, without printing the name", () => {
    const dir = tempCopy();
    try {
      appendFileSync(join(dir, "README.md"), "\nOperated by Acme-Holdings-Example.\n");
      const r = run(dir, "acme-holdings-example");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /README\.md/);
      assert.doesNotMatch(r.stderr, /acme-holdings-example/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("covers server.json when present", () => {
    const dir = tempCopy();
    try {
      writeFileSync(join(dir, "server.json"), JSON.stringify({ repository: { url: "https://github.com/examplecorp-group/x" } }));
      const r = run(dir, "examplecorp-group");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /server\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op when no list is supplied", () => {
    const r = run(repo, undefined);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /not set/);
  });
});
