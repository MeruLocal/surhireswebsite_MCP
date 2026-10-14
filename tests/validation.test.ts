import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  matchesAll,
  normalisePath,
  paginate,
  score,
  terms,
} from "../dist/utils/validation.js";
import { SurhiresError } from "../dist/utils/errors.js";
import { loadConfig } from "../dist/config.js";

const BASE = "https://surhires.com";

describe("normalisePath", () => {
  test("accepts a bare path and adds the leading slash", () => {
    assert.equal(normalisePath("features/resume-parsing", BASE), "/features/resume-parsing");
  });

  test("accepts a full URL on the configured origin", () => {
    assert.equal(normalisePath("https://surhires.com/in/pricing", BASE), "/in/pricing");
  });

  test("strips query strings and fragments", () => {
    assert.equal(normalisePath("/pricing?utm_source=x#plans", BASE), "/pricing");
  });

  test("collapses duplicate and trailing slashes", () => {
    assert.equal(normalisePath("//features//resume-parsing/", BASE), "/features/resume-parsing");
  });

  test("refuses a URL on any other host, so this cannot become an open proxy", () => {
    for (const hostile of [
      "https://evil.example.com/steal",
      "http://surhires.com.evil.example.com/",
      "https://app.surhires.com/dashboard",
    ]) {
      assert.throws(
        () => normalisePath(hostile, BASE),
        (error: unknown) => {
          assert.ok(error instanceof SurhiresError);
          assert.equal(error.kind, "invalid_input");
          assert.match(error.toText(), /only reads surhires\.com/);
          return true;
        },
        `expected ${hostile} to be refused`,
      );
    }
  });

  test("refuses an empty path", () => {
    assert.throws(() => normalisePath("   ", BASE), /must not be empty/);
  });

  test("resolves traversal rather than letting it escape the origin", () => {
    assert.equal(normalisePath("/features/../pricing", BASE), "/pricing");
    assert.equal(normalisePath("/../../etc/passwd", BASE), "/etc/passwd");
  });
});

describe("keyword matching", () => {
  test("splits a query into meaningful terms", () => {
    assert.deepEqual(terms("resume parsing in India"), ["resume", "parsing", "in", "india"]);
    assert.deepEqual(terms("C# .NET"), ["c#", ".net"]);
  });

  test("requires every term to match", () => {
    assert.ok(matchesAll("AI resume parsing and enrichment", terms("resume parsing")));
    assert.ok(!matchesAll("AI resume parsing", terms("resume scheduling")));
  });

  test("is case insensitive", () => {
    assert.ok(matchesAll("Resume Parsing", terms("RESUME parsing")));
  });

  test("weighs a title hit above a body hit", () => {
    const titleHit = score(terms("parsing"), "Resume parsing", "unrelated body");
    const bodyHit = score(terms("parsing"), "Unrelated title", "mentions parsing once");
    assert.ok(titleHit > bodyHit);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 25 }, (_, i) => i);

  test("reports totals and the has_more flag", () => {
    const page = paginate(items, 0, 10);
    assert.equal(page.total, 25);
    assert.equal(page.returned, 10);
    assert.equal(page.has_more, true);
  });

  test("handles the final partial page", () => {
    const page = paginate(items, 20, 10);
    assert.equal(page.returned, 5);
    assert.equal(page.has_more, false);
  });

  test("returns an empty page past the end rather than failing", () => {
    const page = paginate(items, 100, 10);
    assert.deepEqual(page.results, []);
    assert.equal(page.has_more, false);
    assert.equal(page.total, 25);
  });

  test("handles an empty input set", () => {
    const page = paginate([], 0, 10);
    assert.equal(page.total, 0);
    assert.equal(page.has_more, false);
  });
});

describe("loadConfig", () => {
  test("applies documented defaults", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.baseUrl, "https://surhires.com");
    assert.equal(config.market, "in");
    assert.equal(config.timeoutMs, 15_000);
    assert.equal(config.maxConcurrency, 4);
    assert.match(config.userAgent, /^surhires-mcp\/0\.1\.0/);
  });

  test("strips a trailing slash from the base URL", () => {
    assert.equal(loadConfig({ SURHIRES_BASE_URL: "https://surhires.com/" } as NodeJS.ProcessEnv).baseUrl, "https://surhires.com");
  });

  test("coerces numeric env vars from strings", () => {
    const config = loadConfig({ SURHIRES_TIMEOUT_MS: "5000", SURHIRES_MAX_CONCURRENCY: "8" } as NodeJS.ProcessEnv);
    assert.equal(config.timeoutMs, 5_000);
    assert.equal(config.maxConcurrency, 8);
  });

  test("rejects an unknown market with a readable message", () => {
    assert.throws(
      () => loadConfig({ SURHIRES_MARKET: "fr" } as NodeJS.ProcessEnv),
      /Invalid surhires-mcp configuration -- market/,
    );
  });

  test("rejects an out-of-range numeric setting", () => {
    assert.throws(() => loadConfig({ SURHIRES_MAX_CONCURRENCY: "999" } as NodeJS.ProcessEnv), /maxConcurrency/);
  });

  test("never embeds a credential in the user agent, since it holds none", () => {
    const config = loadConfig({ SURHIRES_CONTACT: "ops@example.com" } as NodeJS.ProcessEnv);
    assert.match(config.userAgent, /ops@example\.com/);
    assert.doesNotMatch(config.userAgent, /token|secret|key/i);
  });
});
