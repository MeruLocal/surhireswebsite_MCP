import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asToolResult, parseFailure } from "../utils/errors.js";
import { limitArg, marketArg, offsetArg, paginate, slugArg } from "../utils/validation.js";
import { presentPage, READ_ONLY, resolveSlug, slugOf, toListing, type ToolContext } from "./shared.js";
import { ComparePricingOutput, CompetitorOutput, ListOutput, PricingOutput } from "./schemas.js";

/**
 * Pricing and competitor-comparison tools.
 *
 * Plan figures come from the SoftwareApplication -> AggregateOffer -> Offer
 * JSON-LD on /<market>/pricing, which is the same data Surhires publishes to
 * search engines. Prices are market-specific (INR on /in, and so on), and the
 * site itself labels them provisional -- both facts are surfaced in the result
 * so a caller does not quote them as settled.
 */
export function registerPricingTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_pricing",
    {
      title: "Get Surhires pricing",
      description:
        "Returns Surhires' published per-seat plans for a market: plan names, prices, currency, billing unit and what each plan is for, read from the pricing page's structured data. Also returns the page's pricing FAQ. Prices differ per market, and Surhires labels them provisional -- quote them as published-but-provisional, not final.",
      inputSchema: {
        market: marketArg,
        include_page_text: z
          .boolean()
          .default(false)
          .describe("Also return the pricing page prose, which covers what is and is not included."),
        max_chars: z.coerce.number().int().min(200).max(60_000).default(6_000),
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
        // Static text, not read from the page: these sentences are fixed in code.
        caveats: [
          "Prices are per recruiter seat per month and exclude indirect tax.",
          "The pricing page describes these figures as provisional.",
          "Surhires publishes no free-forever tier; it offers a 14-day trial.",
          "Figures are market-specific. Pass a different market to compare.",
        ],
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
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
        }
        const { page } = result.value;
        return {
          market,
          path: page.path,
          currency: page.pricing?.currency,
          plans:
            page.pricing?.plans.map((p) => ({
              name: p.name,
              price: p.price,
              currency: p.currency,
              unit: p.unit,
            })) ?? [],
        };
      });

      return {
        by_market,
        note: "Each market is priced in its own currency with no conversion applied. Surhires labels all of these figures provisional.",
      };
    }, { structured: true }),
  );

  server.registerTool(
    "list_competitor_comparisons",
    {
      title: "List Surhires competitor comparisons",
      description:
        "Lists the competitors Surhires publishes a head-to-head comparison page against -- Bullhorn, Greenhouse, Lever, Ceipal, Loxo, Manatal, Recruit CRM, Recruiterflow, Vincere, Zoho Recruit, JobAdder, Crelate, Tracker RMS. Also lists the 'alternatives to' pages where they exist.",
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

      return {
        ...paginate(comparisons, offset, limit),
        alternatives_pages: alternatives,
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
        max_chars: z.coerce.number().int().min(200).max(100_000).default(12_000),
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
