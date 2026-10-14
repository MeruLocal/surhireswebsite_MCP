/**
 * End-to-end tool tests: a real MCP client talks to a real MCP server over an
 * in-memory transport, with only the network faked. These exercise the actual
 * registered schemas, so an input-validation or registration mistake fails here.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/utils/logger.js";
import { createMockFetch, type MockFetch } from "./mock-fetch.ts";

let client: Client;
let mock: MockFetch;
let close: () => Promise<void>;

before(async () => {
  mock = createMockFetch();
  const config = loadConfig({ SURHIRES_MARKET: "in", LOG_LEVEL: "error", SURHIRES_MAX_RETRIES: "0" } as NodeJS.ProcessEnv);
  const { server } = buildServer({
    config,
    logger: createLogger({ logLevel: "error" }),
    fetchImpl: mock.fetch,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close = async () => {
    await client.close();
    await server.close();
  };
});

after(async () => {
  await close();
});

/** Calls a tool and returns its parsed JSON payload, asserting it succeeded. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = result.content[0]?.text ?? "";
  assert.ok(!result.isError, `${name} failed: ${text}`);
  return JSON.parse(text);
}

/** Calls a tool expecting a handled error, and returns the error text. */
async function callExpectingError(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  assert.ok(result.isError, `${name} unexpectedly succeeded`);
  return result.content[0]?.text ?? "";
}

describe("tool registration", () => {
  test("advertises every tool with a title and description", async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 20, `expected at least 20 tools, got ${tools.length}`);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a real description`);
      assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
    }
  });

  test("registers the discovery and status tools a caller needs first", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of [
      "list_site_pages",
      "get_page",
      "search_site",
      "get_pricing",
      "list_features",
      "get_feature",
      "list_integrations",
      "get_integration_status",
      "compare_with_competitor",
      "get_api_and_mcp_status",
      "get_server_diagnostics",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  });

  test("states its read-only, unauthenticated scope in the server instructions", async () => {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /NO credentials/);
    assert.match(instructions, /CANNOT search candidates/);
  });
});

describe("list_site_pages", () => {
  test("lists published paths from the sitemap", async () => {
    const result = await call("list_site_pages", { limit: 100 });
    const paths = result.results.map((r: { path: string }) => r.path);
    assert.ok(paths.includes("/pricing"));
    assert.ok(paths.includes("/features/resume-parsing"));
  });

  test("filters to a section", async () => {
    const result = await call("list_site_pages", { section: "integrations" });
    assert.ok(result.results.length > 0);
    assert.ok(result.results.every((r: { path: string }) => r.path.startsWith("/integrations/")));
  });

  test("filters by substring", async () => {
    const result = await call("list_site_pages", { contains: "resume" });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].slug, "resume-parsing");
  });

  test("pages through results", async () => {
    const first = await call("list_site_pages", { limit: 2, offset: 0 });
    const second = await call("list_site_pages", { limit: 2, offset: 2 });
    assert.equal(first.returned, 2);
    assert.equal(first.has_more, true);
    assert.notDeepEqual(first.results, second.results);
  });

  test("rejects an unknown section, naming the valid ones", async () => {
    const text = await callExpectingError("list_site_pages", { section: "candidates" });
    assert.match(text, /Input validation error/);
    assert.match(text, /expected one of .*features/);
  });
});

describe("get_page", () => {
  test("returns structured content for a published page", async () => {
    const page = await call("get_page", { path: "/features/resume-parsing" });
    assert.equal(page.path, "/in/features/resume-parsing");
    assert.equal(page.heading, "Resumes become records, not attachments");
    assert.equal(page.date_modified, "2026-09-08");
    assert.ok(page.outline.length >= 1);
    assert.equal(page.faqs.length, 2);
    assert.match(page.source, /no authenticated ATS data/);
  });

  test("truncates body text and says so", async () => {
    const page = await call("get_page", { path: "/features/resume-parsing", max_chars: 200 });
    assert.equal(page.body_truncated, true);
    assert.match(page.body_text, /truncated/);
    assert.ok(page.body_total_chars > 200);
  });

  test("returns internal links only when asked", async () => {
    const without = await call("get_page", { path: "/vs/bullhorn" });
    const withLinks = await call("get_page", { path: "/vs/bullhorn", include_links: true });
    assert.equal(without.internal_links, undefined);
    assert.ok(Array.isArray(withLinks.internal_links));
  });

  test("reports an unpublished path as a handled error, not a crash", async () => {
    const text = await callExpectingError("get_page", { path: "/candidates/search" });
    assert.match(text, /no published page/);
    assert.match(text, /list_site_pages/);
  });

  test("refuses a path on another host", async () => {
    const text = await callExpectingError("get_page", { path: "https://evil.example.com/x" });
    assert.match(text, /only reads surhires\.com/);
  });

  test("refuses the robots-disallowed /api/ surface", async () => {
    const text = await callExpectingError("get_page", { path: "/api/v1/candidates" });
    assert.match(text, /robots\.txt disallows/);
  });

  test("honours a market override", async () => {
    mock.script("/us/pricing", [{ kind: "body", body: "<html><head><title>US pricing</title></head><body><main><h1>US</h1></main></body></html>" }]);
    const page = await call("get_page", { path: "/pricing", market: "us" });
    assert.equal(page.path, "/us/pricing");
    assert.equal(page.title, "US pricing");
  });
});

describe("search_site", () => {
  test("matches on path and title in shallow mode", async () => {
    const result = await call("search_site", { query: "resume parsing" });
    assert.equal(result.mode, "shallow");
    assert.equal(result.results[0].slug, "resume-parsing");
  });

  test("returns an empty result with guidance rather than inventing a hit", async () => {
    const result = await call("search_site", { query: "quantum teleportation" });
    assert.equal(result.total, 0);
    assert.match(result.note, /deep=true/);
  });

  test("finds body-only wording in deep mode", async () => {
    const shallow = await call("search_site", { query: "optical character recognition" });
    assert.equal(shallow.total, 0);

    const deep = await call("search_site", { query: "optical character recognition", deep: true, section: "features" });
    assert.equal(deep.mode, "deep");
    assert.ok(deep.total >= 1);
    assert.equal(deep.results[0].slug, "resume-parsing");
    assert.ok(deep.results[0].excerpt);
  });

  test("requires every term to match", async () => {
    const result = await call("search_site", { query: "resume bullhorn" });
    assert.equal(result.total, 0);
  });

  test("rejects a one-character query with a readable message", async () => {
    const text = await callExpectingError("search_site", { query: "a" });
    assert.match(text, /Query must be at least 2 characters/);
  });
});

describe("get_pricing", () => {
  test("returns plans with prices, units and caveats", async () => {
    const pricing = await call("get_pricing");
    assert.equal(pricing.currency, "INR");
    assert.equal(pricing.plans.length, 3);
    assert.equal(pricing.plans[0].name, "Starter");
    assert.equal(pricing.plans[0].price, 3500);
    assert.equal(pricing.plans[0].unit, "per user per month, billed monthly");
    assert.ok(pricing.caveats.some((c: string) => /provisional/.test(c)));
    assert.equal(pricing.faqs.length, 1);
  });

  test("reports a parse failure when the offer data is missing", async () => {
    mock.script("/in/pricing", [
      { kind: "body", body: "<html><head><title>Pricing</title></head><body><main><h1>Pricing</h1></main></body></html>" },
    ]);
    // The cached good copy must not mask the scripted response.
    await call("get_server_diagnostics", { clear_cache: true });
    const text = await callExpectingError("get_pricing");
    assert.match(text, /could not extract any plan offers/);
  });
});

describe("catalogue tools", () => {
  test("list_features enumerates feature pages from the sitemap", async () => {
    const result = await call("list_features");
    const slugs = result.results.map((r: { slug: string }) => r.slug);
    assert.deepEqual(slugs.sort(), ["interview-scheduling", "resume-parsing"]);
  });

  test("list_features with detail returns published names and descriptions", async () => {
    const result = await call("list_features", { detail: true });
    const parsing = result.results.find((r: { slug: string }) => r.slug === "resume-parsing");
    assert.equal(parsing.name, "Resumes become records, not attachments");
    assert.match(parsing.description, /structured record/);
    assert.equal(parsing.faq_count, 2);
  });

  test("list_features filters by query", async () => {
    const result = await call("list_features", { query: "scheduling" });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].slug, "interview-scheduling");
  });

  test("get_feature reads one page", async () => {
    const feature = await call("get_feature", { slug: "resume-parsing" });
    assert.equal(feature.slug, "resume-parsing");
    assert.match(feature.body_text, /Extraction and structuring/);
  });

  test("get_feature suggests near matches for an unknown slug", async () => {
    const text = await callExpectingError("get_feature", { slug: "resume-screening" });
    assert.match(text, /no published page/);
    assert.match(text, /resume-parsing/);
  });

  test("get_feature rejects a malformed slug with a readable message", async () => {
    const text = await callExpectingError("get_feature", { slug: "Resume Parsing" });
    assert.match(text, /lowercase words separated by single hyphens/);
  });

  test("list_integrations enumerates connector pages", async () => {
    const result = await call("list_integrations");
    const slugs = result.results.map((r: { slug: string }) => r.slug);
    assert.ok(slugs.includes("naukri"));
    assert.ok(slugs.includes("zapier"));
  });
});

describe("get_integration_status", () => {
  test("surfaces the status language and FAQ for an in-build connector", async () => {
    const status = await call("get_integration_status", { integration: "naukri" });
    assert.equal(status.found, true);
    assert.ok(status.status_sentences.some((s: string) => /in build/.test(s)));
    assert.match(status.faqs[0].answer, /gated on Naukri partner access/);
  });

  test("normalises a spaced name to a slug", async () => {
    const status = await call("get_integration_status", { integration: "Naukri" });
    assert.equal(status.integration, "naukri");
  });

  test("reports found=false with suggestions for an unpublished connector", async () => {
    const status = await call("get_integration_status", { integration: "bamboohr" });
    assert.equal(status.found, false);
    assert.match(status.hint, /list_integrations/);
  });
});

describe("competitor comparisons", () => {
  test("lists comparison pages", async () => {
    const result = await call("list_competitor_comparisons");
    assert.ok(result.results.some((r: { slug: string }) => r.slug === "bullhorn"));
    assert.match(result.note, /vendor's own framing/);
  });

  test("reads one comparison, table included, and flags the bias", async () => {
    const comparison = await call("compare_with_competitor", { competitor: "bullhorn" });
    assert.equal(comparison.competitor, "bullhorn");
    assert.equal(comparison.tables[0].headers[0], "Capability");
    assert.match(comparison.bias_note, /Authored by Surhires/);
    assert.match(comparison.faqs[0].answer, /27 August 2026/);
  });
});

describe("blog tools", () => {
  test("lists posts", async () => {
    const result = await call("list_blog_posts");
    assert.equal(result.total, 2);
    assert.ok(result.results.every((r: { path: string }) => r.path.startsWith("/blog/")));
  });

  test("returns headlines, dates and author with detail", async () => {
    const result = await call("list_blog_posts", { detail: true, sort: "newest" });
    assert.match(result.results[0].headline, /Compliance/);
    assert.ok(result.results[0].date_published);
  });

  test("explains that date sorting needs detail=true", async () => {
    const result = await call("list_blog_posts", { sort: "newest" });
    assert.match(result.note, /needs detail=true/);
  });

  test("reads a post with its author", async () => {
    const post = await call("get_blog_post", {
      slug: "independent-contractor-compliance-guide-in-the-united-states",
    });
    assert.equal(post.author, "The surhires.com team");
    assert.match(post.headline, /Independent Contractor Compliance Guide/);
  });

  test("searches post text in deep mode", async () => {
    const result = await call("search_blog", { query: "state tax withholding", deep: true });
    assert.equal(result.mode, "deep");
    assert.ok(result.results.some((r: { slug: string }) => r.slug.startsWith("remote-hiring")));
  });
});

describe("company and status tools", () => {
  test("get_company_info returns the operating entity", async () => {
    const info = await call("get_company_info");
    assert.equal(info.legal_name, "Soor LLC");
    assert.equal(info.address.country, "US");
    assert.equal(info.contact_points[0].type, "sales");
  });

  test("get_api_and_mcp_status reports the verified absence of an API", async () => {
    const status = await call("get_api_and_mcp_status");
    assert.ok(status.summary.some((s: string) => /No public REST API/.test(s)));
    assert.match(status.what_this_means, /cannot search your candidates/);
    const mcpPage = status.pages.find((p: { path: string }) => p.path === "/in/mcp-server");
    assert.match(mcpPage.body_text, /planned, not shipping/);
  });

  test("get_api_and_mcp_status degrades per page rather than failing wholesale", async () => {
    await call("get_server_diagnostics", { clear_cache: true });
    mock.script("/in/mcp-server", [{ kind: "status", status: 404 }]);
    const status = await call("get_api_and_mcp_status");
    const mcpPage = status.pages.find((p: { path: string }) => p.path === "/in/mcp-server");
    assert.ok(mcpPage, "a failed page should still be listed, under the path actually fetched");
    assert.ok(mcpPage.error, "the failed page should carry an error field");
    const shipping = status.pages.find((p: { path: string }) => p.path === "/in/whats-shipping");
    assert.ok(shipping.body_text, "the other pages should still be returned");
  });

  test("list_legal_documents lists compliance pages", async () => {
    const result = await call("list_legal_documents");
    assert.ok(result.results.some((r: { slug: string }) => r.slug === "dpdpa"));
  });

  test("get_server_diagnostics reports reachability and scope", async () => {
    const diagnostics = await call("get_server_diagnostics");
    assert.equal(diagnostics.default_market, "in");
    assert.equal(diagnostics.surhires_reachable, true);
    assert.ok(diagnostics.pages_in_sitemap > 0);
    assert.match(diagnostics.scope, /Public surhires\.com pages only/);
  });
});

describe("no tool reaches an authenticated or disallowed surface", () => {
  test("every request made during this suite stayed on public pages", () => {
    const offending = mock.calls.filter((path) => path.startsWith("/api/") || path.includes("app.surhires.com"));
    assert.deepEqual(offending, [], `unexpected requests: ${offending.join(", ")}`);
  });

  test("no ATS write tool is advertised", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const forbidden of [
      "submit_job_application",
      "create_job_listing",
      "update_job_listing",
      "manage_candidate_pipeline",
      "search_candidates",
      "get_my_profile",
      "update_my_profile",
    ]) {
      assert.ok(!names.includes(forbidden), `${forbidden} must not exist: Surhires publishes no API for it`);
    }
  });
});
