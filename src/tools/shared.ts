import type { Market } from "../config.js";
import type { SurhiresClient, SitemapEntry } from "../clients/surhires-client.js";
import type { ExtractedPage } from "../clients/extract.js";
import { notFound } from "../utils/errors.js";
import { matchesAll, score, terms } from "../utils/validation.js";

/** Everything a tool handler needs, passed once at registration. */
export interface ToolContext {
  client: SurhiresClient;
  defaultMarket: Market;
  /**
   * Most pages one call may fetch (deep search, detail=true lists). Set for the
   * anonymous HTTP transport; unset over stdio, where each tool's own maximum
   * applies.
   */
  deepPageCap?: number;
}

/** Applies the transport's per-call page budget to a requested page count. */
export function capDeepPages(ctx: ToolContext, requested: number): { pages: number; capped: boolean } {
  if (ctx.deepPageCap === undefined || requested <= ctx.deepPageCap) return { pages: requested, capped: false };
  return { pages: ctx.deepPageCap, capped: true };
}

/**
 * Annotations for every tool here: each one only reads public pages, so it is
 * read-only, never destructive, safe to repeat, and reaches the open web.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Turns "/features/resume-parsing" into "resume-parsing". */
export const slugOf = (path: string): string => path.split("/").filter(Boolean).pop() ?? "";

/** Title-cases a slug for display when a page has not been fetched. */
export const titleise = (slug: string): string =>
  slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Compact listing shape, built from the sitemap without fetching each page. */
export interface Listing {
  slug: string;
  path: string;
  name: string;
  last_modified?: string;
}

export const toListing = (entry: SitemapEntry): Listing => {
  const slug = slugOf(entry.path);
  return { slug, path: entry.path, name: titleise(slug), last_modified: entry.last_modified };
};

/**
 * Resolves a slug inside a section to a real published path.
 *
 * Checked against the sitemap rather than string-built, so a tool can never
 * invent a URL that Surhires does not publish.
 */
export async function resolveSlug(
  ctx: ToolContext,
  section: string,
  slug: string,
): Promise<string> {
  const entries = await ctx.client.sectionPaths(section);
  const wanted = slug.toLowerCase();
  const hit = entries.find((e) => slugOf(e.path) === wanted);
  if (hit) return hit.path;

  const near = entries
    .map((e) => slugOf(e.path))
    .filter((s) => s.includes(wanted.split("-")[0] ?? wanted) || wanted.includes(s))
    .slice(0, 8);

  throw notFound(
    `${section}/${slug}`,
    near.length > 0
      ? `Surhires publishes no such page. Closest published slugs: ${near.join(", ")}.`
      : `Surhires publishes no such page. List the section first to see valid slugs.`,
  );
}

/** Truncates body text, telling the caller when content was cut. */
export function clip(text: string, maxChars: number): { text: string; truncated: boolean; total_chars: number } {
  if (text.length <= maxChars) return { text, truncated: false, total_chars: text.length };
  return {
    text: `${text.slice(0, maxChars)}\n\n[...truncated: ${text.length - maxChars} more characters. Raise max_chars to read on.]`,
    truncated: true,
    total_chars: text.length,
  };
}

/** The standard page payload returned by every page-reading tool. */
export function presentPage(
  page: ExtractedPage,
  opts: { maxChars: number; includeFaqs?: boolean; includeLinks?: boolean },
): Record<string, unknown> {
  const body = clip(page.body_text, opts.maxChars);
  return {
    path: page.path,
    url: page.url,
    title: page.title,
    heading: page.heading,
    description: page.description,
    page_type: page.page_type,
    language: page.language,
    date_published: page.date_published,
    date_modified: page.date_modified,
    breadcrumbs: page.breadcrumbs.map((b) => b.name),
    outline: page.outline,
    body_text: body.text,
    body_truncated: body.truncated,
    body_total_chars: body.total_chars,
    ...(page.tables.length > 0 ? { tables: page.tables } : {}),
    ...(opts.includeFaqs !== false && page.faqs.length > 0 ? { faqs: page.faqs } : {}),
    ...(opts.includeLinks ? { internal_links: page.internal_links } : {}),
    source: "Public surhires.com page content (no authenticated ATS data).",
    content_trust: "untrusted_web_content",
  };
}

/** Searches an already-fetched set of pages by title/description/body. */
export interface SearchHit {
  path: string;
  slug: string;
  title?: string;
  description?: string;
  excerpt?: string;
  relevance: number;
}

export function rank(
  query: string,
  pages: { path: string; title?: string; description?: string; body?: string }[],
): SearchHit[] {
  const queryTerms = terms(query);
  const hits: SearchHit[] = [];

  for (const page of pages) {
    const title = page.title ?? titleise(slugOf(page.path));
    const haystack = `${page.path} ${title} ${page.description ?? ""} ${page.body ?? ""}`;
    if (!matchesAll(haystack, queryTerms)) continue;
    hits.push({
      path: page.path,
      slug: slugOf(page.path),
      title,
      description: page.description,
      excerpt: page.body ? excerptAround(page.body, queryTerms) : undefined,
      relevance: score(queryTerms, title, `${page.path} ${page.description ?? ""} ${page.body ?? ""}`),
    });
  }

  return hits.sort((a, b) => b.relevance - a.relevance || a.path.localeCompare(b.path));
}

/** A window of body text around the first matching term. */
export function excerptAround(body: string, queryTerms: string[], width = 240): string | undefined {
  const lower = body.toLowerCase();
  for (const term of queryTerms) {
    const at = lower.indexOf(term);
    if (at === -1) continue;
    const start = Math.max(0, at - Math.floor(width / 3));
    const slice = body.slice(start, start + width).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "..." : ""}${slice}${start + width < body.length ? "..." : ""}`;
  }
  return undefined;
}

/** Fetches many pages with the client's own concurrency limit doing the work. */
export async function fetchAll(
  ctx: ToolContext,
  paths: string[],
  market?: Market,
): Promise<ExtractedPage[]> {
  const settled = await Promise.allSettled(paths.map((p) => ctx.client.getPage(p, market)));
  return settled
    .filter((r): r is PromiseFulfilledResult<ExtractedPage> => r.status === "fulfilled")
    .map((r) => r.value);
}
