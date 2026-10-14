#!/usr/bin/env node
/**
 * Brand-isolation guard.
 *
 * Fails when any shipped file mentions a name on the forbidden list. The list
 * is NOT stored in this repository (that would publish the very names it
 * guards against): pass it in the FORBIDDEN_BRANDS environment variable,
 * comma-separated, from a CI secret or variable.
 *
 *   FORBIDDEN_BRANDS="name one,name-two" node scripts/check-brands.mjs [root]
 *
 * Matching is case-insensitive substring matching. Exit codes: 0 clean (or no
 * list supplied), 1 a hit was found, 2 usage error.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/** Files and folders that ship or are shown publicly. */
export const SHIPPED = [
  "src",
  "README.md",
  "package.json",
  "server.json",
  "Dockerfile",
  ".env.example",
  "claude_desktop_config.example.json",
  "LICENSE",
];

function walk(path, out) {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry), out);
  } else {
    out.push(path);
  }
}

export function findHits(root, names) {
  const files = [];
  for (const rel of SHIPPED) walk(join(root, rel), files);
  const hits = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const lower = line.toLowerCase();
      for (const name of names) {
        if (lower.includes(name)) hits.push({ file: relative(root, file), line: i + 1, index: names.indexOf(name) });
      }
    });
  }
  return hits;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const root = process.argv[2] ?? process.cwd();
  const names = (process.env.FORBIDDEN_BRANDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (names.length === 0) {
    console.log("check-brands: FORBIDDEN_BRANDS is not set; nothing to check (set it from a CI secret).");
    process.exit(0);
  }

  const hits = findHits(root, names);
  if (hits.length > 0) {
    // Report the location and the list position only, never the name itself,
    // so CI logs do not republish it.
    for (const h of hits) console.error(`check-brands: forbidden name #${h.index + 1} in ${h.file}:${h.line}`);
    process.exit(1);
  }
  console.log(`check-brands: ${names.length} name(s) checked, no hits.`);
}
