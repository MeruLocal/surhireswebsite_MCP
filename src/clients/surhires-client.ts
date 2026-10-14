import type { Config, Market } from "../config.js";
import type { Logger } from "../utils/logger.js";
import {
  blockedByRobots,
  networkFailure,
  notFound,
  rateLimited,
  timedOut,
  upstreamFailure,
} from "../utils/errors.js";
import { extractPage, type ExtractedPage } from "./extract.js";

/**
 * Read-only client for the public surhires.com website.
 *
 * Deliberate constraints:
 *
 *  - GET only. Nothing here can mutate anything on Surhires.
 *  - /api/ is refused before any request is made, because surhires.com's
 *    robots.txt disallows it for every user agent (verified 2026-10-13) and
 *    Surhires publishes no API documentation.
 *  - Market-prefixed paths. surhires.com/features/x 307-redirects to
 *    /<market>/features/x, so the prefix is applied up front to avoid a
 *    pointless redirect hop on every call.
 *  - Blog posts are NOT market-prefixed (/blog/<slug>), which the prefixer
 *    accounts for.
 */

/** Paths robots.txt disallows for all user agents. */
const ROBOTS_DISALLOW = ["/api/"];

/**
 * Path prefixes the site serves outside the market namespace. Blog posts are
 * listed unprefixed in the sitemap but do resolve under a market prefix (their
 * canonical is /<market>/blog/<slug>), so /blog is prefixed like everything else.
 */
const MARKET_EXEMPT = ["/sitemaps", "/sitemap.xml", "/robots.txt", "/_next", "/brand"];

interface CacheEntry {
  html: string;
  storedAt: number;
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "follow" },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}>;

export interface SitemapEntry {
  path: string;
  last_modified?: string;
}

export class SurhiresClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {}

  /** Applies the market prefix unless the path is served outside that namespace. */
  marketPath(path: string, market?: Market): string {
    const m = market ?? this.config.market;
    if (path === "/") return `/${m}`;
    if (path.endsWith("/sitemap.xml")) return path; // e.g. /blog/sitemap.xml
    if (MARKET_EXEMPT.some((p) => path === p || path.startsWith(`${p}/`))) return path;
    if (new RegExp(`^/(?:in|us|gb|au)(?:/|$)`).test(path)) return path;
    return `/${m}${path}`;
  }

  private assertAllowed(path: string): void {
    if (ROBOTS_DISALLOW.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))) {
      throw blockedByRobots(path);
    }
  }

  /** Bounded concurrency so this server never hammers the origin. */
  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.config.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }

  /** Fetches a path as text, with TTL cache, request coalescing and retries. */
  async getText(path: string, market?: Market): Promise<string> {
    // Check the caller's path before prefixing as well as after, so "/api/x"
    // cannot slip through disguised as "/in/api/x".
    this.assertAllowed(path);
    const target = this.marketPath(path, market);
    this.assertAllowed(target.replace(/^\/(?:in|us|gb|au)(?=\/)/, ""));
    this.assertAllowed(target);

    const cached = this.cache.get(target);
    if (cached && Date.now() - cached.storedAt < this.config.cacheTtlMs) {
      this.log.debug("cache hit", { path: target });
      return cached.html;
    }

    // Coalesce concurrent callers asking for the same page.
    const pending = this.inFlight.get(target);
    if (pending) return pending;

    const request = this.withSlot(() => this.fetchWithRetry(target))
      .then((html) => {
        if (this.config.cacheTtlMs > 0) this.cache.set(target, { html, storedAt: Date.now() });
        return html;
      })
      .finally(() => this.inFlight.delete(target));

    this.inFlight.set(target, request);
    return request;
  }

  private async fetchWithRetry(path: string): Promise<string> {
    const url = `${this.config.baseUrl}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.min(2 ** attempt * 250, 4_000);
        this.log.debug("retrying", { path, attempt, backoff_ms: backoff });
        await new Promise((r) => setTimeout(r, backoff));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const started = Date.now();
        const response = await this.fetchImpl(url, {
          headers: {
            "user-agent": this.config.userAgent,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en",
          },
          signal: controller.signal,
          redirect: "follow",
        });
        this.log.debug("fetched", { path, status: response.status, ms: Date.now() - started });

        if (response.status === 404) throw notFound(path);
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after")) || undefined;
          lastError = rateLimited(retryAfter);
          continue; // 429 is worth a backed-off retry.
        }
        if (response.status >= 500) {
          lastError = upstreamFailure(path, response.status);
          continue;
        }
        if (!response.ok) throw upstreamFailure(path, response.status);

        return await response.text();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          lastError = timedOut(path, this.config.timeoutMs);
          continue;
        }
        // Errors we raised deliberately are final; transport errors get a retry.
        if (error instanceof Error && error.name === "SurhiresError") throw error;
        lastError = networkFailure(path, error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? networkFailure(path, "exhausted retries");
  }

  /** Fetches and structurally extracts a page. */
  async getPage(path: string, market?: Market): Promise<ExtractedPage> {
    const target = this.marketPath(path, market);
    const html = await this.getText(path, market);
    return extractPage(target, html);
  }

  /** All URLs from one sitemap file, as site paths. */
  async getSitemap(file: string): Promise<SitemapEntry[]> {
    const xml = await this.getText(file);
    const entries: SitemapEntry[] = [];
    for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
      const inner = block[1] ?? "";
      const loc = inner.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1]?.trim();
      if (!loc) continue;
      let path: string;
      try {
        path = new URL(loc).pathname.replace(/(.)\/$/, "$1");
      } catch {
        continue;
      }
      entries.push({
        path,
        last_modified: inner.match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1]?.trim(),
      });
    }
    return entries;
  }

  /** The sitemap index's child sitemap files. */
  async getSitemapFiles(): Promise<string[]> {
    const xml = await this.getText("/sitemap.xml");
    const files: string[] = [];
    for (const m of xml.matchAll(/<sitemap>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi)) {
      const loc = m[1]?.trim();
      if (!loc) continue;
      try {
        files.push(new URL(loc).pathname);
      } catch {
        /* ignore malformed entry */
      }
    }
    return files;
  }

  /**
   * Every path the site publishes, merged across all sitemap files and cached.
   * This is the index every list/search tool is built on, so one call warms
   * them all.
   */
  async getSiteIndex(): Promise<SitemapEntry[]> {
    const files = await this.getSitemapFiles();
    const merged = new Map<string, SitemapEntry>();
    for (const file of files) {
      try {
        for (const entry of await this.getSitemap(file)) {
          if (!merged.has(entry.path)) merged.set(entry.path, entry);
        }
      } catch (error) {
        // A single unavailable sitemap must not blank the whole index.
        this.log.warn("sitemap unavailable", {
          file,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Paths under a section, e.g. sectionPaths("/features") -> feature pages. */
  async sectionPaths(section: string): Promise<SitemapEntry[]> {
    const index = await this.getSiteIndex();
    const prefix = `${section.replace(/\/$/, "")}/`;
    return index.filter((e) => e.path.startsWith(prefix) && e.path.slice(prefix.length) !== "");
  }

  cacheStats(): { entries: number; ttl_ms: number } {
    return { entries: this.cache.size, ttl_ms: this.config.cacheTtlMs };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
