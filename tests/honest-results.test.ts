/**
 * Failed fetches are reported, never turned into confident empty or default
 * values; static commercial claims are dated or quoted from the page; and
 * results stay inside the response size cap.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/utils/logger.js";
import { fitToCap } from "../dist/utils/errors.js";
import { STATUS_CLAIMS } from "../dist/tools/company.js";
import { createMockFetch, type MockFetch } from "./mock-fetch.ts";
import { RESPONSES, pageHtml } from "./fixtures.ts";

interface Conn {
  mock: MockFetch;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; json?: any; text: string }>;
  tools: () => Promise<{ name: string; description?: string }[]>;
  close: () => Promise<void>;
}

async function connect(responses: Record<string, string> = RESPONSES, env: Record<string, string> = {}): Promise<Conn> {
  const mock = createMockFetch(responses);
  const config = loadConfig({ SURHIRES_MARKET: "in", LOG_LEVEL: "error", SURHIRES_MAX_RETRIES: "0", ...env } as NodeJS.ProcessEnv);
  const { server } = buildServer({ config, logger: createLogger({ logLevel: "error" }), fetchImpl: mock.fetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    mock,
    call: async (name, args = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      const text = r.content[0]?.text ?? "";
      return { isError: r.isError, text, json: r.isError ? undefined : JSON.parse(text) };
    },
    tools: async () => (await client.listTools()).tools,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("failed fetches are reported, not hidden", () => {
  test("list_features detail=true flags the failed page and omits its faq_count", async () => {
    const c = await connect();
    try {
      c.mock.script("/in/features/resume-parsing", [{ kind: "status", status: 500 }]);
      const r = await c.call("list_features", { detail: true });
      assert.ok(!r.isError, r.text);
      const failed = r.json.results.find((x: { slug: string }) => x.slug === "resume-parsing");
      assert.match(failed.detail_error, /HTTP 500/);
      assert.equal(failed.faq_count, undefined);
      assert.equal(r.json.failed_count, 1);
      const ok = r.json.results.find((x: { slug: string }) => x.slug === "interview-scheduling");
      assert.equal(typeof ok.faq_count, "number");
    } finally {
      await c.close();
    }
  });

  test("search_site deep=true is an error when every page failed", async () => {
    const responses: Record<string, string> = {};
    for (const k of ["/sitemap.xml", "/sitemaps/pages.xml", "/blog/sitemap.xml"]) responses[k] = RESPONSES[k]!;
    const c = await connect(responses);
    try {
      const r = await c.call("search_site", { query: "anything", deep: true, section: "features" });
      assert.equal(r.isError, true);
      assert.match(r.text, /None of the 2 pages could be read/);
    } finally {
      await c.close();
    }
  });

  test("search_site deep=true reports pages_failed alongside hits", async () => {
    const c = await connect();
    try {
      c.mock.script("/in/features/interview-scheduling", [{ kind: "status", status: 500 }]);
      const r = await c.call("search_site", { query: "optical character recognition", deep: true, section: "features" });
      assert.ok(!r.isError, r.text);
      assert.equal(r.json.pages_failed, 1);
      assert.equal(r.json.pages_scanned, 1);
    } finally {
      await c.close();
    }
  });

  test("compare_pricing_across_markets reports a parse failure, not plans: []", async () => {
    const responses = {
      ...RESPONSES,
      "/us/pricing": "<html><head><title>US pricing</title></head><body><main><h1>Pricing</h1></main></body></html>",
    };
    const c = await connect(responses);
    try {
      const r = await c.call("compare_pricing_across_markets", { markets: ["in", "us"] });
      const us = r.json.by_market.find((m: { market: string }) => m.market === "us");
      assert.equal(us.plans, undefined);
      assert.match(us.error, /could not extract any plan offers/);
      const india = r.json.by_market.find((m: { market: string }) => m.market === "in");
      assert.equal(india.plans.length, 3);
    } finally {
      await c.close();
    }
  });
});

describe("commercial claims come from the page or carry a date", () => {
  const pricingWithout = (faq: string) => ({
    ...RESPONSES,
    "/in/pricing": pageHtml({
      path: "/in/pricing",
      title: "Pricing",
      heading: "Plans for every desk",
      description: "Pricing.",
      body: "Three plans for recruitment teams.",
      pricing: true,
      faqs: [{ q: "Anything else?", a: faq }],
    }),
  });

  test("no trial, tax or provisional caveat when the page does not say so", async () => {
    const c = await connect(pricingWithout("Contact sales for volume terms."));
    try {
      const r = await c.call("get_pricing");
      const text = JSON.stringify(r.json.caveats);
      assert.doesNotMatch(text, /trial|provisional|tax/i);
      // Prices themselves are unchanged.
      assert.deepEqual(
        r.json.plans.map((p: { price: number }) => p.price),
        [3500, 4500, 8000],
      );
    } finally {
      await c.close();
    }
  });

  test("a trial stated in the FAQ is quoted with its source", async () => {
    const c = await connect(pricingWithout("Yes, there is a 14-day trial."));
    try {
      const r = await c.call("get_pricing");
      const trial = r.json.caveats.find((x: { text?: string }) => /trial/.test(x.text ?? ""));
      assert.deepEqual(trial, { text: "Yes, there is a 14-day trial.", source: "pricing FAQ" });
    } finally {
      await c.close();
    }
  });

  // MAINTENANCE: this test is intentionally time-based. It will start failing
  // about 90 days after STATUS_VERIFIED_ON (src/tools/company.ts), i.e. from
  // 2027-01-12. When it does, do NOT loosen the limit: re-check each claim
  // against Surhires' own pages, then bump STATUS_VERIFIED_ON. Re-verify and
  // bump it before 2027-01-12.
  test("static status claims are re-verified within 90 days", () => {
    for (const claim of STATUS_CLAIMS) {
      const age = (Date.now() - Date.parse(claim.verified_on)) / 86_400_000;
      assert.ok(age <= 90, `"${claim.claim}" was verified ${Math.floor(age)} days ago; re-check it and update verified_on`);
    }
  });

  test("no tool description carries hand counts or a hand-written competitor list", async () => {
    const c = await connect();
    try {
      for (const tool of await c.tools()) {
        assert.doesNotMatch(tool.description ?? "", /~\d+|Bullhorn, Greenhouse/, tool.name);
      }
    } finally {
      await c.close();
    }
  });
});

describe("response size cap and pagination", () => {
  test("a 200k-character page is trimmed to the cap as valid JSON", async () => {
    const huge = {
      ...RESPONSES,
      "/in/features/resume-parsing": pageHtml({
        path: "/in/features/resume-parsing",
        title: "Big",
        heading: "Big page",
        description: "A very long page.",
        body: "word ".repeat(40_000),
      }),
    };
    // A stdio-style operator raised the per-argument limit; the response cap still applies.
    const c = await connect(huge, { MCP_MAX_CHARS_LIMIT: "100000" });
    try {
      const r = await c.call("get_page", { path: "/features/resume-parsing", max_chars: 100_000 });
      assert.ok(!r.isError, r.text.slice(0, 200));
      assert.ok(r.text.length <= 25_000, `response was ${r.text.length} chars`);
      assert.equal(r.json.response_truncated, true);
      assert.equal(r.json.heading, "Big page");
    } finally {
      await c.close();
    }
  });

  test("max_chars above the configured limit is rejected by default", async () => {
    const c = await connect();
    try {
      const r = await c.call("get_page", { path: "/pricing", max_chars: 100_000 });
      assert.equal(r.isError, true);
    } finally {
      await c.close();
    }
  });

  test("fitToCap trims a long list when no long text field is left", () => {
    const value = { results: Array.from({ length: 2_000 }, (_, i) => ({ path: `/p/${i}` })) };
    const { value: out, truncated } = fitToCap(value, 5_000);
    assert.equal(truncated, true);
    assert.ok(JSON.stringify(out, null, 2).length <= 5_000);
    assert.ok((out as { results: unknown[] }).results.length > 0);
  });

  test("list_legal_documents pages with limit/offset", async () => {
    const c = await connect();
    try {
      const r = await c.call("list_legal_documents", { limit: 1 });
      assert.equal(r.json.returned, 1);
      assert.equal(r.json.limit, 1);
    } finally {
      await c.close();
    }
  });

  test("list_resources pages with limit/offset and reports has_more", async () => {
    const urls = ["a", "b"].map((s) => `<url><loc>https://surhires.com/resources/${s}</loc></url>`).join("");
    const responses = {
      ...RESPONSES,
      "/sitemaps/pages.xml": `<?xml version="1.0"?><urlset>${urls}</urlset>`,
      "/in/resources/a": pageHtml({ path: "/in/resources/a", title: "A", heading: "Guide A", description: "A.", body: "A." }),
      "/in/resources/b": pageHtml({ path: "/in/resources/b", title: "B", heading: "Guide B", description: "B.", body: "B." }),
    };
    const c = await connect(responses);
    try {
      const r = await c.call("list_resources", { limit: 1 });
      assert.equal(r.json.total, 2);
      assert.equal(r.json.returned, 1);
      assert.equal(r.json.has_more, true);
      assert.equal(r.json.results[0].title, "Guide A");
    } finally {
      await c.close();
    }
  });
});
