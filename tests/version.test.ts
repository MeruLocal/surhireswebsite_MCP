/** One version source: package.json drives serverInfo, the User-Agent and server.json. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, SERVER_VERSION } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/utils/logger.js";
import { createMockFetch } from "./mock-fetch.ts";

const repo = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
const check = (root: string) =>
  spawnSync(process.execPath, [join(repo, "scripts", "check-versions.mjs"), root], { encoding: "utf8" });

describe("version source", () => {
  test("SERVER_VERSION is package.json's version", () => {
    assert.equal(SERVER_VERSION, pkg.version);
  });

  test("initialize reports the package version and the website", async () => {
    const { server } = buildServer({
      config: loadConfig({ LOG_LEVEL: "error" } as NodeJS.ProcessEnv),
      logger: createLogger({ logLevel: "error" }),
      fetchImpl: createMockFetch().fetch,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const info = client.getServerVersion();
    assert.equal(info?.version, pkg.version);
    assert.equal((info as { websiteUrl?: string }).websiteUrl, "https://surhires.com");
    await client.close();
    await server.close();
  });

  test("the User-Agent carries the package version", () => {
    assert.match(loadConfig({} as NodeJS.ProcessEnv).userAgent, new RegExp(`^surhires-mcp/${pkg.version.replace(/\./g, "\\.")} `));
  });

  test("check-versions passes on the repo and fails on a mismatched copy", () => {
    assert.equal(check(repo).status, 0);
    const dir = mkdtempSync(join(tmpdir(), "versions-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
      writeFileSync(join(dir, "server.json"), readFileSync(join(repo, "server.json")));
      assert.equal(check(dir).status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("server.json uses the Surhires namespace and no repository link", () => {
    const server = JSON.parse(readFileSync(join(repo, "server.json"), "utf8"));
    assert.match(server.name, /^com\.surhires\//);
    assert.equal(server.repository, undefined);
  });
});
