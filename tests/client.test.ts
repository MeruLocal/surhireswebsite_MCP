import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SurhiresClient } from "../dist/clients/surhires-client.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/utils/logger.js";
import { SurhiresError } from "../dist/utils/errors.js";
import { createMockFetch } from "./mock-fetch.ts";
import { PAGES_SITEMAP } from "./fixtures.ts";

const config = (overrides: Record<string, string> = {}) =>
  loadConfig({
    SURHIRES_BASE_URL: "https://surhires.com",
    SURHIRES_MARKET: "in",
    SURHIRES_MAX_RETRIES: "2",
    SURHIRES_TIMEOUT_MS: "1000",
    LOG_LEVEL: "error",
    ...overrides,
  } as NodeJS.ProcessEnv);

const silent = createLogger({ logLevel: "error" });

const build = (overrides: Record<string, string> = {}) => {
  const mock = createMockFetch();
  const client = new SurhiresClient(config(overrides), silent, mock.fetch);
  return { client, mock };
};

describe("market prefixing", () => {
  const { client } = build();

  test("prefixes ordinary paths with the configured market", () => {
    assert.equal(client.marketPath("/features/resume-parsing"), "/in/features/resume-parsing");
    assert.equal(client.marketPath("/pricing"), "/in/pricing");
    assert.equal(client.marketPath("/"), "/in");
  });

  test("prefixes blog posts, whose canonical is market-scoped", () => {
    assert.equal(client.marketPath("/blog/some-post"), "/in/blog/some-post");
  });

  test("leaves sitemaps and robots unprefixed", () => {
    assert.equal(client.marketPath("/sitemap.xml"), "/sitemap.xml");
    assert.equal(client.marketPath("/blog/sitemap.xml"), "/blog/sitemap.xml");
    assert.equal(client.marketPath("/sitemaps/pages.xml"), "/sitemaps/pages.xml");
    assert.equal(client.marketPath("/robots.txt"), "/robots.txt");
  });

  test("does not double-prefix an already prefixed path", () => {
    assert.equal(client.marketPath("/us/pricing"), "/us/pricing");
    assert.equal(client.marketPath("/gb"), "/gb");
  });

  test("honours a per-call market override", () => {
    assert.equal(client.marketPath("/pricing", "au"), "/au/pricing");
  });
});

describe("robots.txt compliance", () => {
  test("refuses /api/ before any request is made", async () => {
    const { client, mock } = build();
    await assert.rejects(
      () => client.getText("/api/jobs"),
      (error: unknown) => {
        assert.ok(error instanceof SurhiresError);
        assert.equal(error.kind, "blocked_by_robots");
        assert.match(error.toText(), /robots\.txt disallows/);
        return true;
      },
    );
    assert.equal(mock.calls.length, 0, "no network call should be attempted");
  });
});

describe("caching and coalescing", () => {
  test("serves a second read from cache", async () => {
    const { client, mock } = build();
    await client.getText("/pricing");
    await client.getText("/pricing");
    assert.equal(mock.calls.filter((c) => c === "/in/pricing").length, 1);
    assert.equal(client.cacheStats().entries, 1);
  });

  test("coalesces concurrent reads of the same path into one request", async () => {
    const { client, mock } = build();
    await Promise.all([client.getText("/pricing"), client.getText("/pricing"), client.getText("/pricing")]);
    assert.equal(mock.calls.filter((c) => c === "/in/pricing").length, 1);
  });

  test("refetches after the cache is cleared", async () => {
    const { client, mock } = build();
    await client.getText("/pricing");
    client.clearCache();
    await client.getText("/pricing");
    assert.equal(mock.calls.filter((c) => c === "/in/pricing").length, 2);
  });

  test("does not cache when the TTL is zero", async () => {
    const { client, mock } = build({ SURHIRES_CACHE_TTL_MS: "0" });
    await client.getText("/pricing");
    await client.getText("/pricing");
    assert.equal(mock.calls.filter((c) => c === "/in/pricing").length, 2);
  });
});

describe("error handling and retries", () => {
  test("maps 404 to an actionable not_found error without retrying", async () => {
    const { client, mock } = build();
    await assert.rejects(
      () => client.getText("/features/does-not-exist"),
      (error: unknown) => {
        assert.ok(error instanceof SurhiresError);
        assert.equal(error.kind, "not_found");
        assert.match(error.toText(), /list_site_pages/);
        return true;
      },
    );
    assert.equal(mock.calls.filter((c) => c === "/in/features/does-not-exist").length, 1);
  });

  test("retries a 500 and succeeds when the origin recovers", async () => {
    const { client, mock } = build();
    mock.script("/in/pricing", [{ kind: "status", status: 500 }]);
    const html = await client.getText("/pricing");
    assert.match(html, /Priced per seat/);
    assert.equal(mock.calls.filter((c) => c === "/in/pricing").length, 2);
  });

  test("surfaces a rate limit with its Retry-After once retries are exhausted", async () => {
    const { client, mock } = build({ SURHIRES_MAX_RETRIES: "1" });
    mock.script("/in/pricing", [
      { kind: "status", status: 429, headers: { "retry-after": "30" } },
      { kind: "status", status: 429, headers: { "retry-after": "30" } },
    ]);
    await assert.rejects(
      () => client.getText("/pricing"),
      (error: unknown) => {
        assert.ok(error instanceof SurhiresError);
        assert.equal(error.kind, "rate_limited");
        assert.match(error.toText(), /Wait 30s/);
        return true;
      },
    );
  });

  test("reports a timeout with the configured budget", async () => {
    const { client, mock } = build({ SURHIRES_MAX_RETRIES: "0", SURHIRES_TIMEOUT_MS: "1234" });
    mock.script("/in/pricing", [{ kind: "abort" }]);
    await assert.rejects(
      () => client.getText("/pricing"),
      (error: unknown) => {
        assert.ok(error instanceof SurhiresError);
        assert.equal(error.kind, "timeout");
        assert.match(error.toText(), /1234ms/);
        return true;
      },
    );
  });

  test("reports a transport failure as a network error after retrying", async () => {
    const { client, mock } = build({ SURHIRES_MAX_RETRIES: "1" });
    mock.script("/in/pricing", [
      { kind: "network", message: "ENOTFOUND" },
      { kind: "network", message: "ENOTFOUND" },
    ]);
    await assert.rejects(
      () => client.getText("/pricing"),
      (error: unknown) => {
        assert.ok(error instanceof SurhiresError);
        assert.equal(error.kind, "network");
        // The raw transport detail (hosts, resolver errors) goes to the log only.
        assert.doesNotMatch(error.toText(), /ENOTFOUND/);
        assert.match(error.toText(), /network error/);
        return true;
      },
    );
  });
});

describe("sitemap indexing", () => {
  test("merges every sitemap file into one path index", async () => {
    const { client } = build();
    const index = await client.getSiteIndex();
    const paths = index.map((e) => e.path);
    assert.ok(paths.includes("/pricing"));
    assert.ok(paths.includes("/features/resume-parsing"));
    assert.ok(paths.includes("/blog/independent-contractor-compliance-guide-in-the-united-states"));
    assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)), "index should be sorted");
  });

  test("keeps the index usable when one sitemap file is unavailable", async () => {
    const { client, mock } = build();
    mock.script("/blog/sitemap.xml", [
      { kind: "status", status: 500 },
      { kind: "status", status: 500 },
      { kind: "status", status: 500 },
    ]);
    const index = await client.getSiteIndex();
    assert.ok(index.some((e) => e.path === "/pricing"));
    assert.ok(!index.some((e) => e.path.startsWith("/blog/")));
  });

  test("carries lastmod through from the sitemap", async () => {
    const { client } = build();
    const index = await client.getSiteIndex();
    assert.equal(index.find((e) => e.path === "/pricing")?.last_modified, "2026-09-08");
  });

  test("sectionPaths returns only children of the section", async () => {
    const { client } = build();
    const features = await client.sectionPaths("/features");
    assert.deepEqual(
      features.map((f) => f.path).sort(),
      ["/features/interview-scheduling", "/features/resume-parsing"],
    );
  });

  test("tolerates a malformed URL entry in a sitemap", async () => {
    const { client, mock } = build();
    mock.script("/sitemaps/pages.xml", [
      { kind: "body", body: PAGES_SITEMAP.replace("https://surhires.com/pricing", "not a url") },
    ]);
    const entries = await client.getSitemap("/sitemaps/pages.xml");
    assert.ok(!entries.some((e) => e.path === "/pricing"));
    assert.ok(entries.some((e) => e.path === "/features/resume-parsing"));
  });
});

describe("concurrency limiting", () => {
  test("never exceeds the configured parallelism", async () => {
    const mock = createMockFetch();
    let active = 0;
    let peak = 0;
    const counting: typeof mock.fetch = async (input, init) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await mock.fetch(input, init);
      } finally {
        active -= 1;
      }
    };

    const client = new SurhiresClient(config({ SURHIRES_MAX_CONCURRENCY: "2" }), silent, counting);
    await Promise.all(
      [
        "/pricing",
        "/features/resume-parsing",
        "/features/interview-scheduling",
        "/integrations/naukri",
        "/integrations/slack",
        "/vs/bullhorn",
      ].map((p) => client.getText(p)),
    );
    assert.ok(peak <= 2, `peak concurrency was ${peak}, expected at most 2`);
  });
});

describe("page extraction through the client", () => {
  test("returns the market-prefixed path it actually fetched", async () => {
    const { client } = build();
    const page = await client.getPage("/features/resume-parsing");
    assert.equal(page.path, "/in/features/resume-parsing");
    assert.equal(page.heading, "Resumes become records, not attachments");
    assert.equal(page.faqs.length, 2);
  });
});

describe("bounded LRU cache", () => {
  test("evicts the least recently used page past SURHIRES_CACHE_MAX_ENTRIES", async () => {
    const { client, mock } = build({ SURHIRES_CACHE_MAX_ENTRIES: "2" });
    const count = (p: string) => mock.calls.filter((c) => c === p).length;
    await client.getText("/pricing"); // A
    await client.getText("/vs/bullhorn"); // B
    await client.getText("/pricing"); // touch A
    await client.getText("/integrations/naukri"); // C evicts B
    assert.equal(client.cacheStats().entries, 2);
    assert.equal(client.cacheStats().max_entries, 2);
    await client.getText("/pricing");
    await client.getText("/vs/bullhorn");
    assert.equal(count("/in/pricing"), 1, "A stayed cached");
    assert.equal(count("/in/vs/bullhorn"), 2, "B was evicted and refetched");
  });
});

describe("redirect handling", () => {
  const withUrls = (overrides: Record<string, string> = {}) => {
    const mock = createMockFetch();
    const urls: string[] = [];
    const fetch: typeof mock.fetch = async (input, init) => {
      urls.push(input);
      assert.equal(init?.redirect, "manual", "redirects must be followed by hand");
      return mock.fetch(input, init);
    };
    return { client: new SurhiresClient(config(overrides), silent, fetch), mock, urls };
  };

  test("follows a same-origin redirect", async () => {
    const { client, mock } = withUrls();
    mock.script("/in/old-pricing", [{ kind: "status", status: 307, headers: { location: "/in/pricing" } }]);
    const html = await client.getText("/old-pricing");
    assert.match(html, /Priced per seat/);
  });

  test("refuses an off-origin redirect without contacting the other host", async () => {
    const { client, mock, urls } = withUrls();
    mock.script("/in/pricing", [{ kind: "status", status: 302, headers: { location: "https://other.example/x" } }]);
    await assert.rejects(
      () => client.getText("/pricing"),
      (error: unknown) => {
        assert.ok(error instanceof SurhiresError);
        assert.equal(error.kind, "upstream");
        assert.match(error.message, /off the Surhires origin/);
        return true;
      },
    );
    assert.ok(urls.every((u) => new URL(u).host === "surhires.com"), urls.join(", "));
  });

  test("refuses a redirect into the robots-disallowed /api/", async () => {
    const { client, mock, urls } = withUrls();
    mock.script("/in/pricing", [{ kind: "status", status: 301, headers: { location: "/in/api/x" } }]);
    await assert.rejects(
      () => client.getText("/pricing"),
      (error: unknown) => error instanceof SurhiresError && error.kind === "blocked_by_robots",
    );
    assert.ok(!urls.some((u) => u.includes("/api/")));
  });
});

describe("outbound body cap", () => {
  test("refuses a page larger than SURHIRES_MAX_PAGE_BYTES", async () => {
    const { client, mock } = build({ SURHIRES_MAX_PAGE_BYTES: "2048" });
    mock.script("/in/pricing", [{ kind: "body", body: "x".repeat(5000) }]);
    await assert.rejects(
      () => client.getText("/pricing"),
      (error: unknown) => error instanceof SurhiresError && error.kind === "upstream" && /too large/.test(error.message),
    );
  });

  test("refuses early on a declared content-length over the cap", async () => {
    const { client, mock } = build({ SURHIRES_MAX_PAGE_BYTES: "2048" });
    mock.script("/in/pricing", [{ kind: "status", status: 200, headers: { "content-length": "999999" } }]);
    await assert.rejects(
      () => client.getText("/pricing"),
      (error: unknown) => error instanceof SurhiresError && /too large/.test(error.message),
    );
  });

  test("reads a streamed body under the cap", async () => {
    const encoder = new TextEncoder();
    const fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "unused",
      headers: { get: () => null },
      body: new Response("<html>streamed</html>").body as never,
    });
    void encoder;
    const client = new SurhiresClient(config(), silent, fetch);
    assert.equal(await client.getText("/pricing"), "<html>streamed</html>");
  });
});
