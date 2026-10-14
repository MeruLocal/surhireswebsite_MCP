import type { Config, Market } from "../config.js";
import type { Logger } from "../utils/logger.js";
import {
  blockedByRobots,
  networkFailure,
  notFound,
  offOriginRedirect,
  pageTooLarge,
  tooManyRedirects,
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
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "follow" | "manual" },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
  /** A WHATWG stream when the fetch implementation provides one; read with a size cap. */
  body?: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> } } | null;
}>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MARKET_PREFIX = /^\/(?:in|us|gb|au)(?=\/)/;

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
    this.assertAllowed(target.replace(MARKET_PREFIX, ""));
    this.assertAllowed(target);

    const cached = this.cache.get(target);
    if (cached) {
      if (Date.now() - cached.storedAt < this.config.cacheTtlMs) {
        // LRU: re-insert so this entry becomes the most recently used.
        this.cache.delete(target);
        this.cache.set(target, cached);
        this.log.debug("cache hit", { path: target });
        return cached.html;
      }
      this.cache.delete(target);
    }

    // Coalesce concurrent callers asking for the same page.
    const pending = this.inFlight.get(target);
    if (pending) return pending;

    const request = this.withSlot(() => this.fetchWithRetry(target))
      .then((html) => {
        if (this.config.cacheTtlMs > 0) this.remember(target, html);
        return html;
      })
      .finally(() => this.inFlight.delete(target));

    this.inFlight.set(target, request);
    return request;
  }

  /** Stores a page, evicting the least recently used entries past the bound. */
  private remember(target: string, html: string): void {
    this.cache.delete(target);
    this.cache.set(target, { html, storedAt: Date.now() });
    while (this.cache.size > this.config.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchWithRetry(path: string): Promise<string> {
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
        const response = await this.fetchFollowingRedirects(path, controller.signal);

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

        return await this.readCapped(path, response);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          lastError = timedOut(path, this.config.timeoutMs);
          continue;
        }
        // Errors we raised deliberately are final; transport errors get a retry.
        if (error instanceof Error && error.name === "SurhiresError") throw error;
        // The raw message can name hosts or resolver detail: log it, do not return it.
        this.log.warn("network failure", { path, detail: error instanceof Error ? error.message : String(error) });
        lastError = networkFailure(path);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? networkFailure(path);
  }

  /**
   * Follows redirects by hand so every hop stays on the configured origin and
   * passes the robots check. A redirect elsewhere is refused before any request
   * is made to the other host.
   */
  private async fetchFollowingRedirects(path: string, signal: AbortSignal) {
    const origin = new URL(this.config.baseUrl);
    let url = new URL(`${this.config.baseUrl}${path}`);

    for (let hop = 0; ; hop += 1) {
      const started = Date.now();
      const response = await this.fetchImpl(url.toString(), {
        headers: {
          "user-agent": this.config.userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en",
        },
        signal,
        redirect: "manual",
      });
      this.log.debug("fetched", { path: url.pathname, status: response.status, ms: Date.now() - started });

      if (!REDIRECT_STATUSES.has(response.status)) return response;
      if (hop >= MAX_REDIRECTS) throw tooManyRedirects(path);

      const location = response.headers.get("location");
      if (!location) return response;
      // Release the redirect response's body before the next hop.
      await response.body?.getReader?.().cancel().catch(() => undefined);
      const next = new URL(location, url);
      if (next.protocol !== origin.protocol || next.host !== origin.host) throw offOriginRedirect(path);
      this.assertAllowed(next.pathname);
      this.assertAllowed(next.pathname.replace(MARKET_PREFIX, ""));
      url = next;
    }
  }

  /** Reads a response body, refusing anything over SURHIRES_MAX_PAGE_BYTES. */
  private async readCapped(
    path: string,
    response: Awaited<ReturnType<FetchLike>>,
  ): Promise<string> {
    const max = this.config.maxPageBytes;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) throw pageTooLarge(path, max);

    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > max) throw pageTooLarge(path, max);
      return text;
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw pageTooLarge(path, max);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
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

  cacheStats(): { entries: number; ttl_ms: number; max_entries: number } {
    return { entries: this.cache.size, ttl_ms: this.config.cacheTtlMs, max_entries: this.config.cacheMaxEntries };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
