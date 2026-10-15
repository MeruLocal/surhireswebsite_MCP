import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asToolResult } from "../utils/errors.js";
import { extractJsonLd, findNode } from "../clients/extract.js";
import {
  limitArg,
  marketArg,
  offsetArg,
  paginate,
  queryArg,
  slugArg,
  sortArg,
} from "../utils/validation.js";
import { ListOutput } from "./schemas.js";
import {
  READ_ONLY,
  assertSomeLoaded,
  capDeepPages,
  failureText,
  fetchAll,
  presentPage,
  rank,
  resolveSlug,
  slugOf,
  titleise,
  maxCharsArg,
  type ToolContext,
} from "./shared.js";

/**
 * Editorial content: the blog, the long-form /resources guides,
 * and the dated product pages (changelog, roadmap, whats-shipping).
 *
 * Blog posts carry a BlogPosting node with headline, datePublished,
 * dateModified and author, so sorting by date needs no guessing.
 */
export function registerContentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_blog_posts",
    {
      title: "List Surhires blog posts",
      description:
        "Lists the posts on the Surhires blog -- mostly practical guides on hiring compliance, contractor classification, payroll and employer-of-record topics. Pass detail=true to get each post's real headline, description and publish date instead of a slug-derived guess.",
      inputSchema: {
        query: queryArg.optional().describe("Optional keyword filter over slug, headline and description."),
        detail: z
          .boolean()
          .default(false)
          .describe("Fetch each post in the returned window for its headline, description and dates."),
        sort: sortArg(["path", "newest", "oldest"], "path").describe(
          "Sort order. 'newest'/'oldest' require detail=true, since dates come from the post pages.",
        ),
        market: marketArg,
        limit: limitArg(20, 60),
        offset: offsetArg,
      },
      annotations: READ_ONLY,
      outputSchema: ListOutput,
    },
    asToolResult(async ({ query, detail, sort, market, limit, offset }) => {
      const entries = await ctx.client.getSitemap("/blog/sitemap.xml");
      let items = entries
        .filter((e) => e.path !== "/blog" && e.path.startsWith("/blog/"))
        .map((e) => ({ slug: slugOf(e.path), path: e.path, name: titleise(slugOf(e.path)) }));

      if (query && !detail) {
        const hits = rank(query, items.map((i) => ({ path: i.path, title: i.name })));
        const order = new Map(hits.map((h, i) => [h.path, i]));
        items = items.filter((i) => order.has(i.path)).sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
      }

      if (!detail) {
        return {
          ...paginate(items, offset, limit),
          sort: "path",
          note:
            sort === "path"
              ? "Headlines are derived from slugs. Pass detail=true for published headlines, descriptions and dates."
              : `Sorting by ${sort} needs detail=true, because dates are only on the post pages. Returned in path order instead.`,
        };
      }

      const budget = capDeepPages(ctx, limit);
      const window = items.slice(offset, offset + budget.pages);
      const fetched = await fetchAll(ctx, window.map((i) => i.path), market);
      const errors = new Map(fetched.failed.map((f) => [f.path, f.error]));

      let detailed = window.map((item) => {
        const page = fetched.byPath.get(item.path);
        return {
          slug: item.slug,
          path: item.path,
          headline: page?.heading ?? item.name,
          description: page?.description,
          date_published: page?.date_published,
          date_modified: page?.date_modified,
          ...(page ? {} : { detail_error: errors.get(item.path) }),
        };
      });

      if (query) {
        const hits = rank(
          query,
          detailed.map((d) => ({ path: d.path, title: d.headline, description: d.description })),
        );
        const order = new Map(hits.map((h, i) => [h.path, i]));
        detailed = detailed.filter((d) => order.has(d.path)).sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
      } else if (sort !== "path") {
        const dir = sort === "newest" ? -1 : 1;
        detailed.sort((a, b) => dir * (a.date_published ?? "").localeCompare(b.date_published ?? ""));
      }

      return {
        total: items.length,
        offset,
        limit,
        returned: detailed.length,
        has_more: offset + window.length < items.length,
        sort,
        ...(budget.capped ? { detail_capped_to: budget.pages } : {}),
        failed_count: fetched.failed.length,
        results: detailed,
        note:
          sort === "path"
            ? undefined
            : "Sorted within the returned window only. Raise limit to sort across more posts.",
      };
    }, { structured: true }),
  );

  server.registerTool(
    "get_blog_post",
    {
      title: "Read a Surhires blog post",
      description:
        "Reads one blog post in full: headline, author, publish and modified dates, heading outline and body text. Call list_blog_posts first for valid slugs.",
      inputSchema: {
        slug: slugArg.describe('Post slug, e.g. "independent-contractor-compliance-guide-in-the-united-states".'),
        market: marketArg,
        max_chars: maxCharsArg(ctx, 15_000),
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ slug, market, max_chars }) => {
      const path = await resolveSlug(ctx, "/blog", slug);
      const html = await ctx.client.getText(path, market);
      const page = await ctx.client.getPage(path, market);
      const posting = findNode(extractJsonLd(html), "BlogPosting", "Article");
      const author = posting?.author as { name?: string } | undefined;

      return {
        slug,
        ...presentPage(page, { maxChars: max_chars, utm: { ctx, tool: "get_blog_post" } }),
        headline: typeof posting?.headline === "string" ? posting.headline : page.heading,
        author: author?.name,
      };
    }),
  );

  server.registerTool(
    "search_blog",
    {
      title: "Search Surhires blog posts",
      description:
        "Searches the blog by keyword. Matches headlines and slugs by default; with deep=true it fetches posts and searches their full text, returning an excerpt around the match. All terms must match.",
      inputSchema: {
        query: queryArg,
        deep: z.boolean().default(false).describe("Fetch and search full post text."),
        deep_max_posts: z.coerce.number().int().min(1).max(40).default(15),
        market: marketArg,
        limit: limitArg(10, 40),
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ query, deep, deep_max_posts, market, limit, offset }) => {
      const entries = (await ctx.client.getSitemap("/blog/sitemap.xml")).filter(
        (e) => e.path.startsWith("/blog/") && e.path !== "/blog",
      );
      const shallow = rank(query, entries.map((e) => ({ path: e.path })));

      if (!deep) {
        const page = paginate(shallow, offset, limit);
        return {
          ...page,
          query,
          mode: "shallow",
          ...(page.total === 0 ? { note: "No slug matched every term. Retry with deep=true to search post text." } : {}),
        };
      }

      const budget = capDeepPages(ctx, deep_max_posts);
      const prioritised = [
        ...shallow.map((h) => h.path),
        ...entries.map((e) => e.path).filter((p) => !shallow.some((h) => h.path === p)),
      ].slice(0, budget.pages);

      const fetched = await fetchAll(ctx, prioritised, market);
      assertSomeLoaded(fetched);
      const hits = rank(
        query,
        fetched.pages.map((p) => ({ path: p.path, title: p.heading, description: p.description, body: p.body_text })),
      );

      return {
        ...paginate(hits, offset, limit),
        query,
        mode: "deep",
        posts_scanned: fetched.pages.length,
        posts_failed: fetched.failed.length,
        total_posts: entries.length,
        ...(budget.capped ? { deep_max_posts_capped_to: budget.pages } : {}),
      };
    }),
  );

  server.registerTool(
    "list_resources",
    {
      title: "List Surhires long-form resources",
      description:
        "Lists the long-form guides under /resources: ATS buying guides, ATS vs recruitment CRM, migrating off Bullhorn, time-to-fill benchmarks, compliance checklists, recruiter template libraries.",
      inputSchema: {
        detail: z.boolean().default(true).describe("Fetch each guide in the returned window for its published title and description."),
        market: marketArg,
        limit: limitArg(50, 100),
        offset: offsetArg,
      },
      annotations: READ_ONLY,
      outputSchema: ListOutput,
    },
    asToolResult(async ({ detail, market, limit, offset }) => {
      const entries = await ctx.client.sectionPaths("/resources");
      if (!detail) {
        return paginate(entries.map((e) => ({ slug: slugOf(e.path), path: e.path })), offset, limit);
      }
      const budget = capDeepPages(ctx, limit);
      const page = paginate(entries, offset, budget.pages);
      const fetched = await fetchAll(ctx, page.results.map((e) => e.path), market);
      const errors = new Map(fetched.failed.map((f) => [f.path, f.error]));
      return {
        ...page,
        limit,
        ...(budget.capped
          ? {
              detail_capped_to: budget.pages,
              note: `This endpoint fetches at most ${budget.pages} guides per call. Page on with offset.`,
            }
          : {}),
        failed_count: fetched.failed.length,
        results: page.results.map((e) => {
          const slug = slugOf(e.path);
          const p = fetched.byPath.get(e.path);
          return {
            slug,
            path: e.path,
            title: p?.heading ?? titleise(slug),
            description: p?.description,
            date_modified: p?.date_modified,
            ...(p ? {} : { detail_error: errors.get(e.path) }),
          };
        }),
      };
    }, { structured: true }),
  );

  server.registerTool(
    "get_changelog",
    {
      title: "Get the Surhires changelog",
      description:
        "Reads Surhires' changelog page: its release policy, what each entry records, and how breaking changes are given notice. Be aware the changelog may be empty by design -- Surhires states it records nothing before general availability and backfills nothing, so an empty result is the real answer, not a failure.",
      inputSchema: { market: marketArg, max_chars: maxCharsArg(ctx, 10_000) },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ market, max_chars }) => {
      const page = await ctx.client.getPage("/changelog", market);
      return presentPage(page, { maxChars: max_chars, utm: { ctx, tool: "get_changelog" } });
    }),
  );

  server.registerTool(
    "get_roadmap",
    {
      title: "Get the Surhires roadmap and shipping status",
      description:
        "Reads Surhires' forward-looking pages -- /roadmap and /whats-shipping -- which state what is in build for the current wave and what has no build under way. The single best source for whether a capability exists today or is only planned.",
      inputSchema: {
        page: z
          .enum(["roadmap", "whats-shipping", "both"])
          .default("both")
          .describe("Which page to read."),
        market: marketArg,
        max_chars: maxCharsArg(ctx, 10_000),
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ page, market, max_chars }) => {
      const wanted = page === "both" ? ["/roadmap", "/whats-shipping"] : [`/${page}`];
      const settled = await Promise.allSettled(wanted.map((p) => ctx.client.getPage(p, market)));

      return {
        pages: settled.map((result, i) =>
          result.status === "fulfilled"
            ? presentPage(result.value, { maxChars: max_chars, utm: { ctx, tool: "get_roadmap" } })
            : {
                path: ctx.client.marketPath(wanted[i]!, market),
                error: failureText(result.reason),
              },
        ),
      };
    }),
  );
}
