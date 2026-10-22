import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/utils/logger.js";
import { createMockFetch } from "./mock-fetch.ts";

let client: Client;
let close: () => Promise<void>;

before(async () => {
  const config = loadConfig({ SURHIRES_MARKET: "in", LOG_LEVEL: "error", SURHIRES_MAX_RETRIES: "0" } as NodeJS.ProcessEnv);
  const { server } = buildServer({ config, logger: createLogger({ logLevel: "error" }), fetchImpl: createMockFetch().fetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  close = async () => {
    await client.close();
    await server.close();
  };
});
after(async () => close());

async function find(need: string): Promise<any> {
  const r = (await client.callTool({ name: "find_recruiting_guidance", arguments: { need } })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.ok(!r.isError, r.content[0]?.text);
  return JSON.parse(r.content[0]!.text);
}

describe("find_recruiting_guidance", () => {
  test("is registered read-only with a title", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "find_recruiting_guidance");
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.ok(tool.title);
  });

  test("maps an ATS comparison need to a published /vs page with a clean canonical URL", async () => {
    const out = await find("compare Bullhorn with a cheaper ATS");
    assert.ok(out.results.some((r: any) => r.path === "/vs/bullhorn"));
    const hit = out.results.find((r: any) => r.path === "/vs/bullhorn");
    assert.doesNotMatch(hit.canonical_url, /utm_/);
    assert.match(hit.url, /utm_campaign=find_recruiting_guidance/);
  });

  test("maps an interview need to the interview page that exists", async () => {
    const out = await find("interview questions and scorecard");
    assert.ok(out.results.some((r: any) => /interview/.test(r.path)));
  });

  test("says plainly when Surhires has no page, instead of inventing one", async () => {
    const out = await find("quantum payroll arbitrage");
    assert.equal(out.total, 0);
    assert.deepEqual(out.results, []);
    assert.match(out.note, /has not published a page/);
  });
});
