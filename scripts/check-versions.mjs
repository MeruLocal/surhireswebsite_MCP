#!/usr/bin/env node
/**
 * Fails when server.json's version differs from package.json's, so the
 * registry manifest cannot drift from the one version source.
 *
 *   node scripts/check-versions.mjs [root]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

const mismatches = [];
if (server.version !== pkg.version) mismatches.push(`server.json version ${server.version} != package.json ${pkg.version}`);
for (const p of server.packages ?? []) {
  if (p.version !== undefined && p.version !== pkg.version) {
    mismatches.push(`server.json packages[${p.identifier}] version ${p.version} != package.json ${pkg.version}`);
  }
}

if (mismatches.length > 0) {
  for (const m of mismatches) console.error(`check-versions: ${m}`);
  process.exit(1);
}
console.log(`check-versions: ${pkg.version} everywhere.`);
