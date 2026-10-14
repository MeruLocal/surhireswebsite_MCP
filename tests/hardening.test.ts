/**
 * Tool-level abuse hardening: the per-call page budget over HTTP, and that an
 * unexpected internal error is never echoed to the caller.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/utils/logger.js";
import { asToolResult } from "../dist/utils/errors.js";
import { createMockFetch } from "./mock-fetch.ts";
import { RESPONSES, pageHtml } from "./fixtures.ts";

async function connect(responses: Record<string, string>, deepPageCap?: number) {
  const mock = createMockFetch(responses);
  const config = loadConfig({ SURHIRES_MARKET: "in", LOG_LEVEL: "error", SURHIRES_MAX_RETRIES: "0" } as NodeJS.ProcessEnv);
  const { server } = buildServer({ config, logger: createLogger({ logLevel: "error" }), fetchImpl: mock.fetch, deepPageCap });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    assert.ok(!r.isError, r.content[0]?.text);
    return JSON.parse(r.content[0]!.text);
  };
  return { mock, call, close: async () => { await client.close(); await server.close(); } };
}

/** A site with many feature and resource pages, to exercise fan-out. */
function bigSite(n: number): Record<string, string> {
  const urls: string[] = [];
  const responses: Record<string, string> = { ...RESPONSES };
  for (let i = 0; i < n; i += 1) {
    for (const section of ["features", "resources"]) {
      const path = `/${section}/page-${i}`;
      urls.push(`<url><loc>https://surhires.com${path}</loc></url>`);
      responses[`/in${path}`] = pageHtml({ path: `/in${path}`, title: `P${i}`, heading: `Page ${i}`, description: `Desc ${i}`, body: `Body text ${i}` });
    }
  }
  responses["/sitemaps/pages.xml"] = `<?xml version="1.0"?><urlset>${urls.join("")}</urlset>`;
  return responses;
}

const pageFetches = (calls: string[]) => calls.filter((c) => /^\/in\/(features|resources)\//.test(c)).length;

describe("per-call page budget (HTTP transport)", () => {
  test("search_site deep=true fetches at most the cap and reports it", async () => {
    const { mock, call, close } = await connect(bigSite(30), 3);
    try {
      const r = await call("search_site", { query: "body text", deep: true, deep_max_pages: 60 });
      assert.equal(r.deep_max_pages_capped_to, 3);
      assert.ok(pageFetches(mock.calls) <= 3, `fetched ${pageFetches(mock.calls)} pages`);
    } finally {
      await close();
    }
  });

  test("list_features detail=true is capped", async () => {
    const { mock, call, close } = await connect(bigSite(30), 3);
    try {
      const r = await call("list_features", { detail: true, limit: 100 });
      assert.equal(r.detail_capped_to, 3);
      assert.equal(r.returned, 3);
      assert.equal(r.has_more, true);
      assert.ok(pageFetches(mock.calls) <= 3);
    } finally {
      await close();
    }
  });

  test("list_resources (detail by default) fetches at most the cap", async () => {
    const { mock, call, close } = await connect(bigSite(30), 10);
    try {
      const r = await call("list_resources");
      assert.equal(r.detail_capped_to, 10);
      assert.equal(r.total, 30);
      assert.ok(pageFetches(mock.calls) <= 10, `fetched ${pageFetches(mock.calls)} pages`);
    } finally {
      await close();
    }
  });

  test("stdio (no cap) keeps the per-tool maximum", async () => {
    const { mock, call, close } = await connect(bigSite(30));
    try {
      const r = await call("search_site", { query: "body text", deep: true, deep_max_pages: 20, section: "features" });
      assert.equal(r.deep_max_pages_capped_to, undefined);
      assert.equal(pageFetches(mock.calls), 20);
    } finally {
      await close();
    }
  });
});

describe("unexpected errors", () => {
  test("a plain Error is not echoed to the caller", async () => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const handler = asToolResult(async () => {
        throw new Error("secret internals at /srv/app");
      });
      const r = await handler({});
      assert.equal(r.isError, true);
      assert.doesNotMatch(r.content[0]!.text, /secret internals/);
      assert.match(r.content[0]!.text, /Unexpected internal error/);
    } finally {
      process.stderr.write = original;
    }
  });
});

describe("shared client across HTTP requests", () => {
  test("two servers built with one client share its cache", async () => {
    const { SurhiresClient } = await import("../dist/clients/surhires-client.js");
    const mock = createMockFetch();
    const config = loadConfig({ SURHIRES_MARKET: "in", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
    const log = createLogger({ logLevel: "error" });
    const shared = new SurhiresClient(config, log, mock.fetch);
    const read = async () => {
      const { server } = buildServer({ config, logger: log, client: shared });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([server.connect(b), client.connect(a)]);
      const r = (await client.callTool({ name: "get_pricing", arguments: {} })) as { isError?: boolean };
      assert.ok(!r.isError);
      await client.close();
      await server.close();
    };
    await read();
    await read();
    assert.equal(mock.calls.filter((c) => c === "/in/pricing").length, 1);
  });
});
