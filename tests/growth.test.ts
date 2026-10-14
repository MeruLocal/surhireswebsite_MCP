/**
 * Conversion and insight: UTM tags on own-site links, the get_started tool,
 * the per-call usage log, and the pricing/features resources and prompt.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import type { Logger } from "../dist/utils/logger.js";
import { withUtm } from "../dist/utils/utm.js";
import { createMockFetch } from "./mock-fetch.ts";
import { RESPONSES, PAGES_SITEMAP } from "./fixtures.ts";

const BASE = "https://surhires.com";

async function connect(responses: Record<string, string> = RESPONSES) {
  const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    error: (msg, fields) => lines.push({ msg, fields }),
    warn: (msg, fields) => lines.push({ msg, fields }),
    info: (msg, fields) => lines.push({ msg, fields }),
    debug: () => undefined,
  };
  const config = loadConfig({ SURHIRES_MARKET: "in", SURHIRES_MAX_RETRIES: "0", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  const { server } = buildServer({ config, logger, fetchImpl: createMockFetch(responses).fetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "growth-test", version: "2.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError, text: r.content[0]!.text, json: r.isError ? undefined : JSON.parse(r.content[0]!.text) };
  };
  return { client, call, lines, close: async () => { await client.close(); await server.close(); } };
}

describe("withUtm", () => {
  test("tags an own-site URL", () => {
    const url = new URL(withUtm(`${BASE}/in/pricing`, "get_pricing", BASE)!);
    assert.equal(url.searchParams.get("utm_source"), "mcp");
    assert.equal(url.searchParams.get("utm_medium"), "ai_agent");
    assert.equal(url.searchParams.get("utm_campaign"), "get_pricing");
  });

  test("keeps existing query parameters and the fragment", () => {
    const url = new URL(withUtm(`${BASE}/in/pricing?a=1#frag`, "t", BASE)!);
    assert.equal(url.searchParams.get("a"), "1");
    assert.equal(url.hash, "#frag");
  });

  test("leaves another host untouched", () => {
    assert.equal(withUtm("https://example.com/x", "t", BASE), "https://example.com/x");
  });

  test("never overwrites or doubles an existing tag", () => {
    const once = withUtm(`${BASE}/x?utm_campaign=newsletter`, "t", BASE)!;
    const twice = withUtm(once, "t", BASE)!;
    assert.equal(twice, once);
    assert.equal(new URL(twice).searchParams.getAll("utm_campaign").join(","), "newsletter");
  });
});

describe("own-site URLs in results carry UTM tags", () => {
  test("get_pricing and get_page", async () => {
    const c = await connect();
    try {
      const pricing = (await c.call("get_pricing")).json;
      assert.equal(new URL(pricing.url).searchParams.get("utm_campaign"), "get_pricing");
      assert.equal(pricing.path, "/in/pricing", "path stays an untagged identifier");
      const page = (await c.call("get_page", { path: "/features/resume-parsing" })).json;
      assert.equal(new URL(page.url).searchParams.get("utm_campaign"), "get_page");
    } finally {
      await c.close();
    }
  });
});

describe("get_started", () => {
  test("returns a tagged pricing URL and the published sales contact, and says when no signup page exists", async () => {
    const c = await connect();
    try {
      const r = (await c.call("get_started")).json;
      const pricing = new URL(r.pricing_url);
      assert.equal(pricing.pathname, "/in/pricing");
      assert.equal(pricing.searchParams.get("utm_campaign"), "get_started");
      assert.equal(r.contact.type, "sales");
      assert.equal(r.signup_url, undefined);
      assert.equal(r.demo_url, undefined);
      assert.match(r.note, /No signup or demo page is published/);
      assert.doesNotMatch(r.call_to_action, /trial|\d/i, "no trial term, price or count in the call to action");
    } finally {
      await c.close();
    }
  });

  test("returns a signup page only when the sitemap publishes one", async () => {
    const sitemap = PAGES_SITEMAP.replace("</urlset>", "<url><loc>https://surhires.com/signup</loc></url></urlset>");
    const c = await connect({ ...RESPONSES, "/sitemaps/pages.xml": sitemap });
    try {
      const r = (await c.call("get_started")).json;
      const signup = new URL(r.signup_url);
      assert.equal(signup.host, "surhires.com");
      assert.equal(signup.pathname, "/in/signup");
      assert.equal(signup.searchParams.get("utm_source"), "mcp");
      assert.equal(r.note, undefined);
    } finally {
      await c.close();
    }
  });
});

describe("usage log", () => {
  test("one tool_call line per call, with no arguments or results", async () => {
    const c = await connect();
    try {
      await c.call("search_site", { query: "a private phrase from a user" });
      const calls = c.lines.filter((l) => l.msg === "tool_call");
      assert.equal(calls.length, 1);
      const f = calls[0]!.fields!;
      assert.equal(f.tool, "search_site");
      assert.equal(f.ok, true);
      assert.equal(typeof f.ms, "number");
      assert.equal(f.client, "growth-test/2.0.0");
      assert.equal(f.arguments, undefined);
      assert.doesNotMatch(JSON.stringify(calls), /private phrase/);
    } finally {
      await c.close();
    }
  });

  test("a failing call logs ok:false and its error kind", async () => {
    const c = await connect();
    try {
      await c.call("get_page", { path: "/does-not-exist" });
      const line = c.lines.find((l) => l.msg === "tool_call")!;
      assert.equal(line.fields!.ok, false);
      assert.equal(line.fields!.error_kind, "not_found");
    } finally {
      await c.close();
    }
  });
});

describe("resources and prompts", () => {
  test("lists the pricing and features resources and reads pricing for a market", async () => {
    const c = await connect();
    try {
      const { resources } = await c.client.listResources();
      const uris = resources.map((r) => r.uri);
      assert.ok(uris.includes("surhires://pricing/in"));
      assert.ok(uris.includes("surhires://features"));
      const read = await c.client.readResource({ uri: "surhires://pricing/in" });
      const pricing = JSON.parse((read.contents[0] as { text: string }).text);
      assert.equal(pricing.plans.length, 3);
      const features = JSON.parse(((await c.client.readResource({ uri: "surhires://features" })).contents[0] as { text: string }).text);
      assert.ok(features.results.some((f: { slug: string }) => f.slug === "resume-parsing"));
    } finally {
      await c.close();
    }
  });

  test("recommend_plan routes to the tools and states no price itself", async () => {
    const c = await connect();
    try {
      const { prompts } = await c.client.listPrompts();
      assert.ok(prompts.some((p) => p.name === "recommend_plan"));
      const got = await c.client.getPrompt({ name: "recommend_plan", arguments: { team_size: "5", market: "in" } });
      const text = (got.messages[0]!.content as { text: string }).text;
      assert.match(text, /get_pricing/);
      assert.match(text, /get_started/);
      assert.doesNotMatch(text, /INR|₹|\$|trial/i);
    } finally {
      await c.close();
    }
  });
});
