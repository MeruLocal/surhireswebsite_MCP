import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asToolResult, parseFailure } from "../utils/errors.js";
import {
  limitArg,
  marketArg,
  normalisePath,
  offsetArg,
  paginate,
  queryArg,
} from "../utils/validation.js";
import { assertSomeLoaded, capDeepPages, fetchAll, presentPage, rank, READ_ONLY, slugOf, maxCharsArg, type ToolContext } from "./shared.js";
import { ListOutput } from "./schemas.js";

const SECTIONS = [
  "features",
  "integrations",
  "solutions",
  "resources",
  "blog",
  "vs",
  "tools",
  "legal",
  "partners",
] as const;

export function registerPageTools(server: McpServer, ctx: ToolContext, baseUrl: string): void {
  server.registerTool(
    "list_site_pages",
    {
      title: "List published Surhires pages",
      description:
        "Lists every page Surhires publishes, read from its sitemap index. Use this to discover valid paths and slugs before calling any other tool. Optionally filter to one section.",
      inputSchema: {
        section: z
          .enum(SECTIONS)
          .optional()
          .describe("Restrict to one section of the site. Omit for every published page."),
        contains: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("Keep only paths containing this substring."),
        limit: limitArg(100, 500),
        offset: offsetArg,
      },
      annotations: READ_ONLY,
      outputSchema: ListOutput,
    },
    asToolResult(async ({ section, contains, limit, offset }) => {
      const index = section
        ? await ctx.client.sectionPaths(`/${section}`)
        : await ctx.client.getSiteIndex();

      const filtered = contains
        ? index.filter((e) => e.path.toLowerCase().includes(contains.toLowerCase()))
        : index;

      return {
        ...paginate(
          filtered.map((e) => ({ path: e.path, slug: slugOf(e.path), last_modified: e.last_modified })),
          offset,
          limit,
        ),
        note: "Paths are unprefixed as published in the sitemap. The server applies the market prefix (e.g. /in) automatically when fetching.",
      };
    }, { structured: true }),
  );

  server.registerTool(
    "get_page",
    {
      title: "Read a Surhires page",
      description:
        "Fetches any published Surhires page by path and returns its structured content: title, heading, description, publish/modified dates, heading outline, body text, any comparison tables, and the page's FAQ entries. Works for every path list_site_pages returns.",
      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1)
          .describe('Site path, e.g. "/features/resume-parsing" or "/pricing". A full surhires.com URL is also accepted.'),
        market: marketArg,
        max_chars: maxCharsArg(ctx, 8_000),
        include_links: z
          .boolean()
          .default(false)
          .describe("Also return the internal links found on the page, useful for crawling onward."),
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ path, market, max_chars, include_links }) => {
      const clean = normalisePath(path, baseUrl);
      const page = await ctx.client.getPage(clean, market);
      return presentPage(page, { maxChars: max_chars, includeLinks: include_links, utm: { ctx, tool: "get_page" } });
    }),
  );

  server.registerTool(
    "search_site",
    {
      title: "Search Surhires' published pages",
      description:
        "Keyword search across Surhires' published pages. By default it matches page paths and titles, which is fast. Set deep=true to fetch candidate pages and search their full body text and FAQ answers -- slower, but finds wording that is not in the title. All query terms must match.",
      inputSchema: {
        query: queryArg,
        section: z
          .enum(SECTIONS)
          .optional()
          .describe("Restrict the search to one section of the site."),
        deep: z
          .boolean()
          .default(false)
          .describe("Fetch and search full page text. Slower; respects the configured concurrency limit."),
        deep_max_pages: z.coerce
          .number()
          .int()
          .min(1)
          .max(60)
          .default(25)
          .describe("When deep=true, the maximum number of pages to fetch and scan."),
        limit: limitArg(10, 50),
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ query, section, deep, deep_max_pages, limit, offset }) => {
      const index = section
        ? await ctx.client.sectionPaths(`/${section}`)
        : await ctx.client.getSiteIndex();

      if (index.length === 0) throw parseFailure("/sitemap.xml", "any published page paths");

      const shallow = rank(
        query,
        index.map((e) => ({ path: e.path })),
      );

      if (!deep) {
        const page = paginate(shallow, offset, limit);
        return {
          ...page,
          query,
          mode: "shallow",
          ...(page.total === 0
            ? {
                note: "No page path or title matched every term. Retry with deep=true to search full page text, or with fewer terms.",
              }
            : {}),
        };
      }

      // Deep mode: scan the shallow winners first, then fill up to the budget
      // with the rest of the section so a non-title match is still reachable.
      const budget = capDeepPages(ctx, deep_max_pages);
      const prioritised = [
        ...shallow.map((h) => h.path),
        ...index.map((e) => e.path).filter((p) => !shallow.some((h) => h.path === p)),
      ].slice(0, budget.pages);

      const fetched = await fetchAll(ctx, prioritised);
      assertSomeLoaded(fetched);
      const hits = rank(
        query,
        fetched.pages.map((p) => ({
          path: p.path,
          title: p.title,
          description: p.description,
          body: `${p.body_text}\n${p.faqs.map((f) => `${f.question} ${f.answer}`).join("\n")}`,
        })),
      );

      const page = paginate(hits, offset, limit);
      return {
        ...page,
        query,
        mode: "deep",
        pages_scanned: fetched.pages.length,
        pages_failed: fetched.failed.length,
        ...(budget.capped ? { deep_max_pages_capped_to: budget.pages } : {}),
        ...(prioritised.length < index.length
          ? {
              note: budget.capped
                ? `Scanned ${prioritised.length} of ${index.length} pages (this endpoint caps deep search at ${budget.pages} pages per call). Narrow with section or a more specific query to cover more.`
                : `Scanned ${prioritised.length} of ${index.length} pages. Raise deep_max_pages or narrow with section to cover more.`,
            }
          : {}),
      };
    }),
  );

  server.registerTool(
    "get_page_faqs",
    {
      title: "Get a page's FAQ entries",
      description:
        "Returns just the question-and-answer pairs Surhires publishes on a page, taken from the page's structured data. Most feature, integration and comparison pages carry 4-8 entries, and they often hold the specifics -- limits, caveats, what is not supported -- that the prose does not.",
      inputSchema: {
        path: z.string().trim().min(1).describe('Site path, e.g. "/features/resume-parsing".'),
        market: marketArg,
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ path, market }) => {
      const clean = normalisePath(path, baseUrl);
      const page = await ctx.client.getPage(clean, market);
      if (page.faqs.length === 0) {
        return {
          path: page.path,
          faqs: [],
          note: "This page publishes no FAQ structured data. Call get_page for its prose instead.",
        };
      }
      return { path: page.path, title: page.title, count: page.faqs.length, faqs: page.faqs };
    }),
  );
}
