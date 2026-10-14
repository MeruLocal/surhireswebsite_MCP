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
}
