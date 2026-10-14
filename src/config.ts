import { z } from "zod";
import { SERVER_VERSION } from "./version.js";

/** Markets Surhires publishes localised pages for, verified from /sitemaps/markets.xml. */
export const MARKETS = ["in", "us", "gb", "au"] as const;
export type Market = (typeof MARKETS)[number];

const intFromEnv = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const ConfigSchema = z.object({
  baseUrl: z.string().url().default("https://surhires.com"),
  market: z.enum(MARKETS).default("in"),
  timeoutMs: intFromEnv(15_000, 1_000, 120_000),
  maxRetries: intFromEnv(2, 0, 5),
  maxConcurrency: intFromEnv(4, 1, 16),
  cacheTtlMs: intFromEnv(900_000, 0, 86_400_000),
  // Upper bound on cached pages. The client is shared for the life of the HTTP
  // process, so the cache must not grow without limit (LRU eviction).
  cacheMaxEntries: intFromEnv(500, 1, 100_000),
  // Outbound pages larger than this are refused rather than read into memory.
  maxPageBytes: intFromEnv(5 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  // Largest serialised tool result, in characters. Bigger results are trimmed
  // (largest text field first, then the longest list) and flagged.
  maxResponseChars: intFromEnv(25_000, 2_000, 1_000_000),
  // Upper bound on every tool's max_chars argument. Raise it (with
  // MCP_MAX_RESPONSE_CHARS) for stdio clients that accept larger results.
  maxCharsLimit: intFromEnv(25_000, 200, 100_000),
  contact: z.string().default("unspecified"),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  port: intFromEnv(3000, 1, 65_535),
  httpHost: z.string().default("127.0.0.1"),
  // Extra Host header values the HTTP transport will accept, beyond localhost.
  // Behind a proxy or in a container the Host is the public name, which DNS-
  // rebinding protection would otherwise reject. "*" disables that check.
  allowedHosts: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((h) => h.trim()).filter(Boolean)),
  // Extra browser Origins the HTTP transport accepts. Requests with no Origin
  // header (non-browser MCP clients) are unaffected. "*" accepts any Origin.
  allowedOrigins: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((h) => h.trim().replace(/\/+$/, "")).filter(Boolean)),
  // Requests per minute per client on POST /mcp. 0 disables the limiter.
  rateLimitPerMin: intFromEnv(60, 0, 100_000),
  // Number of trusted reverse-proxy hops in front of this server. 0 = key the
  // rate limit on the socket address. N = key on the Nth X-Forwarded-For entry
  // from the right. Legacy true/yes/1 mean 1. Anything unparsable means 0.
  trustProxy: z
    .string()
    .default("")
    .transform((s): number => {
      const v = s.trim().toLowerCase();
      if (v === "true" || v === "yes") return 1;
      if (!/^\d+$/.test(v)) return 0;
      return Math.min(Number(v), 10);
    }),
  // Pages one HTTP tool call may fetch (deep search and detail=true lists).
  httpDeepMaxPages: intFromEnv(10, 1, 100),
  // Public origin advertised on the status page and discovery document, e.g.
  // https://mcp.surhires.com. Never derived from the request's Host header.
  publicBaseUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "MCP_PUBLIC_BASE_URL must be an https:// URL")
    .transform((u) => u.replace(/\/+$/, ""))
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema> & { userAgent: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    baseUrl: env.SURHIRES_BASE_URL,
    market: env.SURHIRES_MARKET,
    timeoutMs: env.SURHIRES_TIMEOUT_MS,
    maxRetries: env.SURHIRES_MAX_RETRIES,
    maxConcurrency: env.SURHIRES_MAX_CONCURRENCY,
    cacheTtlMs: env.SURHIRES_CACHE_TTL_MS,
    cacheMaxEntries: env.SURHIRES_CACHE_MAX_ENTRIES,
    maxPageBytes: env.SURHIRES_MAX_PAGE_BYTES,
    maxResponseChars: env.MCP_MAX_RESPONSE_CHARS,
    maxCharsLimit: env.MCP_MAX_CHARS_LIMIT,
    contact: env.SURHIRES_CONTACT,
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
    httpHost: env.MCP_HTTP_HOST,
    allowedHosts: env.MCP_ALLOWED_HOSTS,
    allowedOrigins: env.MCP_ALLOWED_ORIGINS,
    rateLimitPerMin: env.MCP_RATE_LIMIT_PER_MIN,
    trustProxy: env.TRUST_PROXY,
    httpDeepMaxPages: env.MCP_HTTP_DEEP_MAX_PAGES,
    publicBaseUrl: env.MCP_PUBLIC_BASE_URL || undefined,
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid surhires-mcp configuration -- ${detail}`);
  }

  const cfg = parsed.data;
  return {
    ...cfg,
    baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
    userAgent: `surhires-mcp/${SERVER_VERSION} (+https://modelcontextprotocol.io; contact: ${cfg.contact})`,
  };
}
