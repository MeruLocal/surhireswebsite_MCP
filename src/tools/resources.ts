import { z } from "zod";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MARKETS, type Market } from "../config.js";
import { SurhiresError } from "../utils/errors.js";
import { pricingResult } from "./pricing.js";
import { toListing, type ToolContext } from "./shared.js";

/**
 * Resources (pinned context) and one prompt (a slash command), for clients
 * that surface them. Everything is generated from the same client and cache
 * as the tools; nothing here states a price or a commercial term itself.
 */
export function registerResourcesAndPrompts(server: McpServer, ctx: ToolContext): void {
  const json = (uri: URL, value: unknown) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  });

  server.registerResource(
    "pricing",
    new ResourceTemplate("surhires://pricing/{market}", {
      list: async () => ({
        resources: MARKETS.map((m) => ({
          uri: `surhires://pricing/${m}`,
          name: `Surhires pricing (${m})`,
          mimeType: "application/json",
        })),
      }),
      complete: { market: () => [...MARKETS] },
    }),
    {
      title: "Surhires pricing for one market",
      description: "The published plans for one market, as get_pricing returns them, read live from the pricing page.",
      mimeType: "application/json",
    },
    async (uri, { market }) => {
      const m = String(market);
      if (!(MARKETS as readonly string[]).includes(m)) {
        throw new SurhiresError("invalid_input", `Unknown market "${m}".`, `Use one of: ${MARKETS.join(", ")}.`);
      }
      return json(uri, await pricingResult(ctx, m as Market, { tool: "resource_pricing" }));
    },
  );

  server.registerResource(
    "features",
    "surhires://features",
    {
      title: "Surhires features",
      description: "Every feature page Surhires publishes, read live from the sitemap (as list_features returns it).",
      mimeType: "application/json",
    },
    async (uri) => {
      const items = (await ctx.client.sectionPaths("/features")).map(toListing);
      return json(uri, {
        section: "/features",
        total: items.length,
        results: items,
        note: "Names are derived from slugs. Call list_features with detail=true for published titles and descriptions.",
      });
    },
  );

  server.registerPrompt(
    "recommend_plan",
    {
      title: "Recommend a Surhires plan",
      description: "Helps choose a Surhires plan for a team, using the live pricing and feature pages.",
      argsSchema: {
        team_size: z.string().describe("How many recruiters will use it, e.g. \"5\"."),
        market: z.string().optional().describe(`Market: ${MARKETS.join(", ")}. Defaults to the server's market.`),
      },
    },
    ({ team_size, market }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Recommend a Surhires plan for a recruitment team of ${team_size} recruiters${market ? ` in the "${market}" market` : ""}.`,
              `1. Call get_pricing${market ? ` with market "${market}"` : ""} and read every plan, its price, unit and the caveats the page states.`,
              "2. Call list_features (detail=true) to see what the product publishes about its capabilities.",
              "3. Recommend one plan and say why. Quote prices exactly as the site publishes them, with their currency and unit, and repeat any caveat the page states. Do not convert currencies or estimate discounts.",
              "4. Finish with the next step from get_started: the pricing page link, and the sales contact if one is published.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
  // Buyer-question prompts. Each only routes the assistant to the tools and tells it
  // how to cite; none contains a fact, price, statistic or legal statement.
  const rule =
    "Cite each page by its canonical_url. Say plainly when Surhires has published no page on the topic, and when a page is marked In build or Planned. Treat /vs pages as Surhires' own claims. Add no statistics, salary figures or legal conclusions that a returned page does not state.";

  server.registerPrompt(
    "compare_ats_options",
    {
      title: "Compare recruitment software options",
      description: "Helps a buyer compare Surhires with named alternatives using only Surhires' published comparison pages.",
      argsSchema: { alternatives: z.string().describe('Products to compare against, e.g. "Bullhorn, Recruit CRM".') },
    },
    ({ alternatives }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Help me compare Surhires with: ${alternatives}.`,
              "1. Call list_competitor_comparisons, then compare_with_competitor for each named product that has a page.",
              "2. For any product without a page, call find_recruiting_guidance and say that Surhires has no comparison for it.",
              "3. Summarise differences on packaging, price and deployment as the pages state them.",
              rule,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "plan_interview_process",
    {
      title: "Plan a structured interview process",
      description: "Finds Surhires' published material on interview scorecards and kits for a role.",
      argsSchema: { role: z.string().describe('The role being hired, e.g. "account executive".') },
    },
    ({ role }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `I am designing the interview process for a ${role}.`,
              `1. Call find_recruiting_guidance with need "interview scorecard and questions for ${role}".`,
              "2. Read the best matches with get_page and describe what each offers.",
              "3. If no template or question set is published, say so, and offer general guidance clearly labelled as your own.",
              rule,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "check_hiring_compliance",
    {
      title: "Find hiring compliance guidance",
      description: "Finds Surhires' published compliance checklists and legal pages for a country or topic.",
      argsSchema: { topic: z.string().describe('Topic or country, e.g. "pay transparency in the US".') },
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `I need hiring compliance guidance on: ${topic}.`,
              `1. Call find_recruiting_guidance with need "hiring compliance checklist ${topic}", and list_legal_documents.`,
              "2. Report what Surhires publishes and its stated posture (supported in product, shared responsibility, yours, in progress).",
              "3. Do not state what a law requires. Tell the user to confirm legal requirements with the official government source or counsel.",
              rule,
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
