import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asToolResult, parseFailure } from "../utils/errors.js";
import { limitArg, marketArg, offsetArg, paginate, slugArg } from "../utils/validation.js";
import { failureText, presentPage, READ_ONLY, resolveSlug, slugOf, toListing, maxCharsArg, type ToolContext } from "./shared.js";
import type { ExtractedPage } from "../clients/extract.js";
import { ComparePricingOutput, CompetitorOutput, ListOutput, PricingOutput } from "./schemas.js";

/**
 * Pricing and competitor-comparison tools.
 *
 * Plan figures come from the SoftwareApplication -> AggregateOffer -> Offer
 * JSON-LD on /<market>/pricing, which is the same data Surhires publishes to
 * search engines. Prices are market-specific (INR on /in, and so on), and the
 * terms that qualify them (provisional status, trial, tax) are quoted from the
 * page itself with their source, never asserted from code.
 */

/** Terms worth quoting when the pricing page states them. */
const CAVEAT_TOPICS: RegExp[] = [/provisional/i, /\btrial\b/i, /\b(?:tax|gst|vat)\b/i, /free[- ]forever|free tier|free plan/i];

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

/**
 * Caveats derived from the page at call time: the billing unit and currency
 * from the Offer nodes, then any sentence on the page or in its FAQ that
 * speaks to a qualifying term, quoted with where it came from. What the page
 * does not say is omitted rather than asserted.
 */
export function pricingCaveats(page: ExtractedPage): ({ text: string; source: string } | string)[] {
  const out: ({ text: string; source: string } | string)[] = [];
  const pricing = page.pricing;
  if (pricing) {
    const units = [...new Set(pricing.plans.map((p) => p.unit).filter((u): u is string => Boolean(u)))];
    const currency = pricing.currency ?? pricing.plans.find((p) => p.currency)?.currency;
    if (currency || units.length > 0) {
      out.push({
        text: [currency ? `Prices are in ${currency}` : "Prices are", units.length > 0 ? `billed as published: ${units.join("; ")}` : ""]
          .filter(Boolean)
          .join(", ")
          .concat("."),
        source: "pricing page structured data",
      });
    }
  }

  const candidates: { text: string; source: string }[] = [
    ...sentences(`${page.heading ?? ""}. ${page.body_text}`).map((text) => ({ text, source: "pricing page" })),
    ...page.faqs.flatMap((f) => sentences(f.answer).map((text) => ({ text, source: "pricing FAQ" }))),
  ];
  const quoted = new Set<string>();
  for (const topic of CAVEAT_TOPICS) {
    const hit = candidates.find((c) => topic.test(c.text) && !quoted.has(c.text));
    if (!hit) continue;
    quoted.add(hit.text);
    out.push({ text: hit.text.length > 300 ? `${hit.text.slice(0, 297)}...` : hit.text, source: hit.source });
  }

  out.push("Figures are market-specific. Pass a different market to compare.");
  return out;
}
export function registerPricingTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_pricing",
    {
      title: "Get Surhires pricing",
      description:
        "Returns Surhires' published per-seat plans for a market: plan names, prices, currency, billing unit and what each plan is for, read from the pricing page's structured data. Also returns the page's pricing FAQ, and caveats quoted from the page itself (each with its source). Prices differ per market; quote them as published, with the page's own caveats.",
      inputSchema: {
        market: marketArg,
        include_page_text: z
          .boolean()
          .default(false)
          .describe("Also return the pricing page prose, which covers what is and is not included."),
        max_chars: maxCharsArg(ctx, 6_000),
      },
      annotations: READ_ONLY,
      outputSchema: PricingOutput,
    },
    asToolResult(async ({ market, include_page_text, max_chars }) => {
      const page = await ctx.client.getPage("/pricing", market);
      if (!page.pricing || page.pricing.plans.length === 0) {
        throw parseFailure(page.path, "any plan offers from the pricing page's structured data");
      }

      return {
        market: market ?? ctx.defaultMarket,
        path: page.path,
        url: page.url,
        currency: page.pricing.currency,
        price_range: { low: page.pricing.low_price, high: page.pricing.high_price },
        plan_count: page.pricing.plan_count ?? page.pricing.plans.length,
        plans: page.pricing.plans,
        faqs: page.faqs,
        ...(include_page_text
          ? { page: presentPage(page, { maxChars: max_chars, includeFaqs: false }) }
          : {}),
        caveats: pricingCaveats(page),
        date_modified: page.date_modified,
      };
    }, { structured: true }),
  );

  server.registerTool(
    "compare_pricing_across_markets",
    {
      title: "Compare Surhires pricing across markets",
      description:
        "Fetches the pricing page for several markets at once and returns the plans side by side. Useful for seeing how Surhires prices the same plan in India, the US, the UK and Australia. Currencies differ, so no conversion is applied and none should be inferred.",
      inputSchema: {
        markets: z
          .array(z.enum(["in", "us", "gb", "au"]))
          .min(1)
          .max(4)
          .default(["in", "us", "gb", "au"])
          .describe("Markets to compare."),
      },
      annotations: READ_ONLY,
      outputSchema: ComparePricingOutput,
    },
    asToolResult(async ({ markets }) => {
      const settled = await Promise.allSettled(
        markets.map(async (m) => ({ market: m, page: await ctx.client.getPage("/pricing", m) })),
      );

      const by_market = settled.map((result, i) => {
        const market = markets[i]!;
        if (result.status === "rejected") {
          return {
            market,
            error: failureText(result.reason),
          };
        }
        const { page } = result.value;
        // Same rule as get_pricing: a page with no parsable offers is an error,
        // not a market with zero plans.
        if (!page.pricing || page.pricing.plans.length === 0) {
          return {
            market,
            error: parseFailure(page.path, "any plan offers from the pricing page's structured data").message,
          };
        }
        return {
          market,
          path: page.path,
          currency: page.pricing.currency,
          plans: page.pricing.plans.map((p) => ({
            name: p.name,
            price: p.price,
            currency: p.currency,
            unit: p.unit,
          })),
        };
      });

      return {
        by_market,
        note: "Each market is priced in its own currency with no conversion applied. Call get_pricing for one market to see the caveats its page states.",
      };
    }, { structured: true }),
  );

  server.registerTool(
    "list_competitor_comparisons",
    {
      title: "List Surhires competitor comparisons",
      description:
        "Lists the competitors Surhires publishes a head-to-head comparison page against, read live from the sitemap. Also lists the 'alternatives to' pages where they exist; both lists page with limit/offset.",
      inputSchema: { limit: limitArg(50, 100), offset: offsetArg },
      annotations: READ_ONLY,
      outputSchema: ListOutput,
    },
    asToolResult(async ({ limit, offset }) => {
      const comparisons = (await ctx.client.sectionPaths("/vs")).map(toListing);
      const index = await ctx.client.getSiteIndex();
      const alternatives = index
        .filter((e) => /^\/alternatives-to-/.test(e.path))
        .map((e) => ({ path: e.path, competitor: e.path.replace("/alternatives-to-", "") }));
      const altPage = paginate(alternatives, offset, limit);

      return {
        ...paginate(comparisons, offset, limit),
        alternatives_pages: altPage.results,
        alternatives_total: altPage.total,
        alternatives_has_more: altPage.has_more,
        note: "Surhires writes these pages itself, so they are a vendor's own framing of a competitor. Each page's FAQ states when the competitor's pricing was last verified.",
      };
    }, { structured: true }),
  );

  server.registerTool(
    "compare_with_competitor",
    {
      title: "Read a Surhires vs competitor page",
      description:
        "Reads one head-to-head comparison page in full: how Surhires frames the difference in packaging, price and deployment, any comparison table on the page, where it concedes the competitor is the better choice, and the FAQ entry stating when the competitor's pricing was last verified. This is vendor-authored material -- treat it as Surhires' claim, not neutral analysis.",
      inputSchema: {
        competitor: slugArg.describe('Competitor slug, e.g. "bullhorn", "greenhouse", "zoho-recruit". Call list_competitor_comparisons for valid slugs.'),
        market: marketArg,
        max_chars: maxCharsArg(ctx, 12_000),
      },
      annotations: READ_ONLY,
      outputSchema: CompetitorOutput,
    },
    asToolResult(async ({ competitor, market, max_chars }) => {
      const path = await resolveSlug(ctx, "/vs", competitor);
      const page = await ctx.client.getPage(path, market);
      return {
        competitor: slugOf(path),
        ...presentPage(page, { maxChars: max_chars }),
        bias_note:
          "Authored by Surhires about a competitor. Verify any competitor pricing or packaging claim against that vendor's own site before relying on it.",
      };
    }, { structured: true }),
  );
}
