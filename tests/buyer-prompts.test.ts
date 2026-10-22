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

describe("buyer-question prompts", () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ["compare_ats_options", { alternatives: "Bullhorn" }, /compare_with_competitor/],
    ["plan_interview_process", { role: "recruiter" }, /find_recruiting_guidance/],
    ["check_hiring_compliance", { topic: "pay transparency" }, /official government source/],
  ];
  for (const [name, args, expected] of cases) {
    test(`${name} routes to tools, requires citations and states no facts`, async () => {
      const res = await client.getPrompt({ name, arguments: args });
      const text = (res.messages[0]!.content as { text: string }).text;
      assert.match(text, expected);
      assert.match(text, /canonical_url/);
      assert.doesNotMatch(text, /\$\d|\d+%/);
    });
  }
});
