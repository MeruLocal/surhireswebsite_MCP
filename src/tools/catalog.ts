import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asToolResult } from "../utils/errors.js";
import { limitArg, marketArg, offsetArg, paginate, queryArg, slugArg } from "../utils/validation.js";
import { ListOutput } from "./schemas.js";
import {
  READ_ONLY,
  capDeepPages,
  fetchAll,
  presentPage,
  rank,
  resolveSlug,
  slugOf,
  toListing,
  type ToolContext,
} from "./shared.js";

/**
 * Catalogue tools over the three big enumerable sections of the site:
 * /features (~45 pages), /integrations (~40), /solutions (~14).
 *
 * Listing is driven by the sitemap, so it cannot drift out of date against a
 * hardcoded array; names and descriptions are enriched from each page's
 * structured data when the caller asks for detail.
 */
export function registerCatalogTools(server: McpServer, ctx: ToolContext): void {
  const registerSection = (opts: {
    section: "features" | "integrations" | "solutions";
    listName: string;
    getName: string;
    listTitle: string;
    getTitle: string;
    listDescription: string;
    getDescription: string;
    slugExample: string;
  }) => {
    server.registerTool(
      opts.listName,
      {
        title: opts.listTitle,
        description: opts.listDescription,
        inputSchema: {
          query: queryArg.optional().describe("Optional keyword filter applied to slug, name and description."),
          detail: z
            .boolean()
            .default(false)
            .describe(
              "Fetch each page to return its real published name and description. Slower but far more informative than slugs alone.",
            ),
          market: marketArg,
          limit: limitArg(50, 100),
          offset: offsetArg,
        },
        annotations: READ_ONLY,
        outputSchema: ListOutput,
      },
      asToolResult(async ({ query, detail, market, limit, offset }) => {
        const entries = await ctx.client.sectionPaths(`/${opts.section}`);
        let items = entries.map(toListing);

        // Shallow filter first so detail mode only fetches what might match.
        if (query && !detail) {
          const hits = rank(query, items.map((i) => ({ path: i.path, title: i.name })));
          const order = new Map(hits.map((h, i) => [h.path, i]));
          items = items
            .filter((i) => order.has(i.path))
            .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
        }

        if (!detail) {
          return {
            section: `/${opts.section}`,
            ...paginate(items, offset, limit),
            note: "Names are derived from slugs. Pass detail=true for each page's published title and description.",
          };
        }

        const budget = capDeepPages(ctx, limit);
        const window = items.slice(offset, offset + budget.pages);
        const pages = await fetchAll(ctx, window.map((i) => i.path), market);
        const byPath = new Map(pages.map((p) => [slugOf(p.path), p]));

        let detailed = window.map((item) => {
          const page = byPath.get(item.slug);
          return {
            slug: item.slug,
            path: item.path,
            name: page?.heading ?? item.name,
            description: page?.description,
            date_modified: page?.date_modified,
            faq_count: page?.faqs.length ?? 0,
          };
        });

        if (query) {
          const hits = rank(
            query,
            detailed.map((d) => ({ path: d.path, title: d.name, description: d.description })),
          );
          const order = new Map(hits.map((h, i) => [h.path, i]));
          detailed = detailed
            .filter((d) => order.has(d.path))
            .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
        }

        return {
          section: `/${opts.section}`,
          total: items.length,
          offset,
          limit,
          returned: detailed.length,
          has_more: offset + window.length < items.length,
          ...(budget.capped ? { detail_capped_to: budget.pages } : {}),
          results: detailed,
        };
      }, { structured: true }),
    );

    server.registerTool(
      opts.getName,
      {
        title: opts.getTitle,
        description: opts.getDescription,
        inputSchema: {
          slug: slugArg.describe(`Page slug, e.g. "${opts.slugExample}". Call ${opts.listName} for valid slugs.`),
          market: marketArg,
          max_chars: z.coerce
            .number()
            .int()
            .min(200)
            .max(100_000)
            .default(10_000)
            .describe("Maximum characters of body text before truncating."),
        },
        annotations: READ_ONLY,
      },
      asToolResult(async ({ slug, market, max_chars }) => {
        const path = await resolveSlug(ctx, `/${opts.section}`, slug);
        const page = await ctx.client.getPage(path, market);
        return { slug, ...presentPage(page, { maxChars: max_chars }) };
      }),
    );
  };

  registerSection({
    section: "features",
    listName: "list_features",
    getName: "get_feature",
    listTitle: "List Surhires product features",
    getTitle: "Get a Surhires feature page",
    listDescription:
      "Lists every product feature Surhires publishes a page for -- applicant tracking, resume parsing, AI agents, interview scheduling, pipeline management, compliance tooling and so on. Start here to find out what the product claims to do.",
    getDescription:
      "Reads one feature page in full: what the feature does, how it works, its stated limits, and the FAQ entries that usually carry the caveats. Note that some pages describe capability that is in build rather than shipping -- the page text says which.",
    slugExample: "resume-parsing",
  });

  registerSection({
    section: "integrations",
    listName: "list_integrations",
    getName: "get_integration",
    listTitle: "List Surhires integrations",
    getTitle: "Get a Surhires integration page",
    listDescription:
      "Lists every third-party integration Surhires publishes a page for: job boards (Naukri, Indeed, Seek, LinkedIn Recruiter), ATSs, assessment, background checks, e-signature, payroll, comms and payments. Important: a page existing does not mean the connector is live -- several say they are in build.",
    getDescription:
      "Reads one integration page in full, including its stated status. The FAQ on these pages typically answers directly whether the connector is connected today, what it is gated on, and what the workaround is meanwhile.",
    slugExample: "naukri",
  });

  registerSection({
    section: "solutions",
    listName: "list_solutions",
    getName: "get_solution",
    listTitle: "List Surhires solution pages",
    getTitle: "Get a Surhires solution page",
    listDescription:
      "Lists the audience- and vertical-specific pages: staffing agencies, executive search, RPO providers, IT and healthcare recruitment, blue-collar staffing, in-house talent teams, remote hiring and more.",
    getDescription:
      "Reads one solution page in full -- how Surhires positions itself for that audience, the workflow it describes, and the FAQ entries for that segment.",
    slugExample: "staffing-agencies",
  });

  server.registerTool(
    "list_free_tools",
    {
      title: "List Surhires' free recruiter tools",
      description:
        "Lists the free public calculators and generators Surhires hosts: boolean string generator, resume screener, placement fee and ROI calculators, time-to-fill calculator, pay transparency checker, job description analyzer, recruiter email templates. These are web pages, not APIs -- this tool returns their descriptions and paths so a person can open them.",
      inputSchema: { market: marketArg, detail: z.boolean().default(true).describe("Fetch each page for its published description.") },
      annotations: READ_ONLY,
      outputSchema: ListOutput,
    },
    asToolResult(async ({ market, detail }) => {
      const entries = await ctx.client.sectionPaths("/tools");
      if (!detail) return { total: entries.length, results: entries.map(toListing) };

      const budget = capDeepPages(ctx, entries.length);
      const pages = await fetchAll(ctx, entries.slice(0, budget.pages).map((e) => e.path), market);
      const bySlug = new Map(pages.map((p) => [slugOf(p.path), p]));
      return {
        total: entries.length,
        ...(budget.capped ? { detail_capped_to: budget.pages } : {}),
        results: entries.map((e) => {
          const slug = slugOf(e.path);
          const page = bySlug.get(slug);
          return {
            slug,
            path: e.path,
            name: page?.heading ?? slug,
            description: page?.description,
          };
        }),
        note: "These are interactive web pages. This server reads their published copy; it cannot run a calculator for you.",
      };
    }, { structured: true }),
  );
}
