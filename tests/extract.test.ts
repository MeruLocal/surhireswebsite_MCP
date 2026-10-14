import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractFaqs,
  extractJsonLd,
  extractOrganization,
  extractPage,
  extractPricing,
  textOf,
} from "../dist/clients/extract.js";
import { pageHtml, RESPONSES } from "./fixtures.ts";

describe("extractJsonLd", () => {
  test("flattens @graph containers into individual nodes", () => {
    const nodes = extractJsonLd(RESPONSES["/in/pricing"]!);
    const types = nodes.flatMap((n) => (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]));
    assert.ok(types.includes("Organization"));
    assert.ok(types.includes("WebPage"));
    assert.ok(types.includes("SoftwareApplication"));
  });

  test("skips a malformed block instead of failing the page", () => {
    const html = `<script type="application/ld+json">{ not json }</script>
      <script type="application/ld+json">{"@type":"WebPage","name":"Still parsed"}</script>`;
    const nodes = extractJsonLd(html);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.name, "Still parsed");
  });

  test("returns nothing for a page with no structured data", () => {
    assert.deepEqual(extractJsonLd("<html><body><p>plain</p></body></html>"), []);
  });
});

describe("textOf", () => {
  test("strips tags and decodes entities", () => {
    assert.equal(textOf("<p>Packaging &amp; price &mdash; 50&#37;</p>"), "Packaging & price — 50%");
  });

  test("drops script and style content entirely", () => {
    assert.equal(textOf("<div>keep<script>var x=1;</script><style>.a{}</style></div>"), "keep");
  });

  test("collapses runaway whitespace", () => {
    assert.equal(textOf("<p>a</p>\n\n\n\n<p>b</p>"), "a\n\nb");
  });
});

describe("extractFaqs", () => {
  test("reads Question/Answer pairs out of an ItemList", () => {
    const faqs = extractFaqs(extractJsonLd(RESPONSES["/in/features/resume-parsing"]!));
    assert.equal(faqs.length, 2);
    assert.equal(faqs[0]!.question, "How accurate is it?");
    assert.match(faqs[1]!.answer, /optical character recognition/);
  });

  test("returns an empty list when a page publishes no FAQ", () => {
    assert.deepEqual(extractFaqs(extractJsonLd(RESPONSES["/in/integrations/slack"]!)), []);
  });
});

describe("extractPricing", () => {
  test("reads the AggregateOffer and each plan Offer", () => {
    const pricing = extractPricing(extractJsonLd(RESPONSES["/in/pricing"]!));
    assert.ok(pricing);
    assert.equal(pricing.currency, "INR");
    assert.equal(pricing.low_price, 2900);
    assert.equal(pricing.high_price, 8000);
    assert.equal(pricing.plans.length, 3);

    const starter = pricing.plans[0]!;
    assert.equal(starter.name, "Starter");
    assert.equal(starter.price, 3500);
    assert.equal(starter.unit, "per user per month, billed monthly");
    assert.deepEqual(starter.eligible_regions, ["IN"]);
  });

  test("returns undefined when the page carries no SoftwareApplication offer", () => {
    assert.equal(extractPricing(extractJsonLd(RESPONSES["/in/integrations/slack"]!)), undefined);
  });
});

describe("extractPage", () => {
  const page = extractPage("/in/vs/bullhorn", RESPONSES["/in/vs/bullhorn"]!);

  test("prefers structured data for metadata", () => {
    assert.equal(page.heading, "Recruitment software that is not gated behind the top tier");
    assert.equal(page.language, "en-IN");
    assert.equal(page.date_modified, "2026-09-08");
    assert.equal(page.page_type, "WebPage");
    assert.equal(page.canonical_url, "https://surhires.com/in/vs/bullhorn");
  });

  test("builds an ordered breadcrumb trail", () => {
    assert.deepEqual(page.breadcrumbs.map((b) => b.name), [
      "Home",
      "Recruitment software that is not gated behind the top tier",
    ]);
  });

  test("captures the heading outline", () => {
    assert.ok(page.outline.length >= 1);
    assert.equal(page.outline[0]!.level, 2);
  });

  test("parses comparison tables into headers and rows", () => {
    assert.equal(page.tables.length, 1);
    assert.equal(page.tables[0]!.caption, "Packaging & price");
    assert.deepEqual(page.tables[0]!.headers, ["Capability", "Surhires", "Them"]);
    assert.deepEqual(page.tables[0]!.rows, [["AI matching", "Professional", "Top tier only"]]);
  });

  test("excludes nav and footer chrome from body text", () => {
    assert.doesNotMatch(page.body_text, /Terms/);
    assert.doesNotMatch(page.body_text, /should.*be stripped/);
    assert.match(page.body_text, /very large enterprise deployments/);
  });

  test("collects internal links without Next.js assets", () => {
    const paths = page.internal_links.map((l) => l.path);
    assert.ok(paths.includes("/in/features/resume-parsing"));
    assert.ok(!paths.some((p) => p.startsWith("/_next")));
  });

  test("falls back to meta description and title on a bare page", () => {
    const bare = extractPage(
      "/in/bare",
      '<html><head><title>Bare | Surhires</title><meta name="description" content="Fallback copy"/></head><body><main><h1>Bare</h1></main></body></html>',
    );
    assert.equal(bare.title, "Bare | Surhires");
    assert.equal(bare.description, "Fallback copy");
    assert.equal(bare.heading, "Bare");
    assert.deepEqual(bare.faqs, []);
  });
});

describe("extractOrganization", () => {
  test("returns the operating company and its address", () => {
    const org = extractOrganization(RESPONSES["/in"]!);
    assert.ok(org);
    assert.equal(org.legalName, "Soor LLC");
    assert.equal((org.address as Record<string, unknown>).addressCountry, "US");
  });

  test("returns undefined when absent", () => {
    const html = pageHtml({
      path: "/in/x",
      title: "t",
      heading: "h",
      description: "d",
      body: "b",
    }).replace(/<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@graph":\[\{"@type":"Organization[\s\S]*?<\/script>/, "");
    assert.equal(extractOrganization(html), undefined);
  });
});
