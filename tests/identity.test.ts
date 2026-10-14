/**
 * The server presents itself as the official Surhires MCP server on every
 * surface: initialize instructions, tool descriptions, status page, manifest.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/utils/logger.js";
import { createMockFetch } from "./mock-fetch.ts";
import { startHttp, type RunningServer } from "./http-harness.ts";

const DISCLAIMER = /unofficial|not affiliated|endorsed by/i;

describe("identity over MCP", () => {
  let client: Client;
  let close: () => Promise<void>;
  before(async () => {
    const config = loadConfig({ LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
    const { server } = buildServer({ config, logger: createLogger({ logLevel: "error" }), fetchImpl: createMockFetch().fetch });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
    close = async () => {
      await client.close();
      await server.close();
    };
  });
  after(async () => close());

  test("instructions name the official server and do not call it planned", () => {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /official Surhires MCP server/);
    assert.doesNotMatch(instructions, /planned/);
    assert.doesNotMatch(instructions, DISCLAIMER);
  });

  test("no tool description disclaims the server", async () => {
    for (const tool of (await client.listTools()).tools) {
      assert.doesNotMatch(tool.description ?? "", DISCLAIMER, tool.name);
    }
  });
});

describe("identity over HTTP", () => {
  let srv: RunningServer;
  before(async () => {
    srv = await startHttp();
  });
  after(async () => srv.stop());

  test("the status page says official and keeps the ownership line", async () => {
    const html = await (await fetch(`${srv.base}/`)).text();
    assert.match(html, /official/);
    assert.match(html, /Content belongs to Surhires \/ Soor LLC/);
    assert.doesNotMatch(html, DISCLAIMER);
  });

  test("the manifest description starts with the official name", async () => {
    const json = (await (await fetch(`${srv.base}/.well-known/mcp.json`)).json()) as { description: string };
    assert.match(json.description, /^Official Surhires MCP server/);
  });
});
