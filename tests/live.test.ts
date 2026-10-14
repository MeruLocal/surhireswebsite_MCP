/**
 * Live integration tests against the real surhires.com.
 *
 * Skipped unless SURHIRES_LIVE=1, so the default suite stays offline and
 * deterministic. These are the tests that prove the extractors still match the
 * real site; run them when a tool starts returning thin results.
 *
 *   SURHIRES_LIVE=1 npm run test:live
 *
 * They are read-only GETs of public pages, rate-limited by the client's own
 * concurrency cap. Assertions deliberately check structure rather than exact
 * copy, because Surhires edits its wording.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/utils/logger.js";

const live = process.env.SURHIRES_LIVE === "1";

let client: Client;
let close: () => Promise<void>;

before(async () => {
  if (!live) return;
  const { server } = buildServer({
    config: loadConfig({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" }),
    logger: createLogger({ logLevel: (process.env.LOG_LEVEL as "warn") ?? "warn" }),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "live-test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  close = async () => {
    await client.close();
    await server.close();
  };
});

after(async () => {
  if (live) await close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = result.content[0]?.text ?? "";
  assert.ok(!result.isError, `${name} failed: ${text}`);
  return JSON.parse(text);
}

describe("live surhires.com", { skip: live ? false : "set SURHIRES_LIVE=1 to run" }, () => {
  test("the sitemap index yields a substantial page list", async () => {
    const result = await call("list_site_pages", { limit: 500 });
    assert.ok(result.total > 100, `expected >100 published pages, got ${result.total}`);
    assert.ok(result.results.some((r: { path: string }) => r.path === "/pricing"));
  });

  test("pricing still exposes plan offers in structured data", async () => {
    const pricing = await call("get_pricing");
    assert.ok(pricing.plans.length >= 2, "pricing page should expose at least two plans");
    assert.ok(pricing.currency, "pricing should carry a currency");
    for (const plan of pricing.plans) {
      assert.ok(plan.name, "each plan needs a name");
    }
  });

  test("a feature page yields heading, body and FAQ entries", async () => {
    const feature = await call("get_feature", { slug: "resume-parsing" });
    assert.ok((feature.heading ?? "").length > 5);
    assert.ok(feature.body_text.length > 500, "body extraction should not be thin");
    assert.ok(feature.faqs?.length >= 1, "feature pages publish FAQ structured data");
  });

  test("a comparison page yields a table and a bias note", async () => {
    const comparison = await call("compare_with_competitor", { competitor: "bullhorn" });
    assert.ok(comparison.outline.length > 3);
    assert.match(comparison.bias_note, /Authored by Surhires/);
  });

  test("the company record still names the operating entity", async () => {
    const info = await call("get_company_info");
    assert.ok(info.legal_name, "Organization structured data should carry a legalName");
    assert.ok(info.address.country, "Organization should carry an address");
  });

  test("the API status pages still load and still say there is no API", async () => {
    const status = await call("get_api_and_mcp_status");
    const loaded = status.pages.filter((p: { body_text?: string }) => p.body_text);
    assert.ok(loaded.length >= 2, "at least two of the three status pages should load");

    // If this assertion ever fails, Surhires may have shipped an API -- which is
    // the signal to revisit the scope of this server rather than a test bug.
    const combined = loaded.map((p: { body_text: string }) => p.body_text).join(" ").toLowerCase();
    assert.ok(
      /planned|not shipping|no build|in development|not usable/.test(combined),
      "status pages no longer describe these surfaces as unshipped -- re-verify whether an API now exists",
    );
  });

  test("the robots guard refuses /api/ against the real origin too", async () => {
    const result = (await client.callTool({
      name: "get_page",
      arguments: { path: "/api/candidates" },
    })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /robots\.txt disallows/);
  });

  test("a market override fetches that market's localised pricing", async () => {
    const [india, uk] = await Promise.all([
      call("get_pricing", { market: "in" }),
      call("get_pricing", { market: "gb" }),
    ]);
    assert.notEqual(india.currency, uk.currency, "markets should price in different currencies");
  });

  test("deep search finds body-only wording", async () => {
    const result = await call("search_site", {
      query: "resume",
      section: "features",
      deep: true,
      deep_max_pages: 6,
    });
    assert.equal(result.mode, "deep");
    assert.ok(result.pages_scanned > 0);
  });

  test("blog posts carry headlines and publish dates", async () => {
    const result = await call("list_blog_posts", { detail: true, limit: 3, sort: "newest" });
    assert.ok(result.results.length > 0);
    assert.ok(result.results[0].headline);
    assert.ok(result.results[0].date_published, "BlogPosting should carry datePublished");
  });
});
