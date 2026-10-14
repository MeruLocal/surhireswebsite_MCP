/**
 * Error taxonomy. Every message is written to be actionable for the model and
 * for the operator, and never carries request headers or configuration values
 * that could leak a secret into a transcript.
 */

export type ErrorKind =
  | "not_found"
  | "blocked_by_robots"
  | "unsupported_operation"
  | "rate_limited"
  | "timeout"
  | "network"
  | "upstream"
  | "parse"
  | "invalid_input";

export class SurhiresError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly hint?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SurhiresError";
  }

  /** Single string shown to the model: what happened, then what to do about it. */
  toText(): string {
    return this.hint ? `${this.message}\n\nNext step: ${this.hint}` : this.message;
  }
}

export const notFound = (path: string, hint?: string) =>
  new SurhiresError(
    "not_found",
    `Surhires has no published page at "${path}".`,
    hint ?? 'Call list_site_pages to see every path this server can read, or search_site with a keyword.',
    404,
  );

export const blockedByRobots = (path: string) =>
  new SurhiresError(
    "blocked_by_robots",
    `Refusing to fetch "${path}": surhires.com/robots.txt disallows this path for all user agents.`,
    "This server only reads crawl-permitted public pages. Surhires' /api/ surface is robots-disallowed and has no published documentation, so it cannot be read here.",
  );

export const unsupported = (what: string, why: string, hint: string) =>
  new SurhiresError("unsupported_operation", `${what} is not supported by this server: ${why}`, hint);

export const rateLimited = (retryAfterSeconds?: number) =>
  new SurhiresError(
    "rate_limited",
    "surhires.com returned HTTP 429 (too many requests).",
    retryAfterSeconds
      ? `Wait ${retryAfterSeconds}s before retrying, or lower SURHIRES_MAX_CONCURRENCY.`
      : "Wait before retrying, or lower SURHIRES_MAX_CONCURRENCY.",
    429,
  );

export const timedOut = (path: string, ms: number) =>
  new SurhiresError(
    "timeout",
    `Request for "${path}" timed out after ${ms}ms.`,
    "Retry, or raise SURHIRES_TIMEOUT_MS if the network is slow.",
  );

/**
 * The raw transport error (which can name hosts, IPs or resolver detail) goes
 * to the operator log only; the caller gets a fixed phrase.
 */
export const networkFailure = (path: string) =>
  new SurhiresError(
    "network",
    `Could not reach surhires.com for "${path}": network error.`,
    "Retry shortly. If it persists, call get_server_diagnostics.",
  );

export const offOriginRedirect = (path: string) =>
  new SurhiresError(
    "upstream",
    `surhires.com redirected "${path}" off the Surhires origin; not followed.`,
    "This server only reads the configured Surhires origin. Verify the path with list_site_pages.",
  );

export const tooManyRedirects = (path: string) =>
  new SurhiresError("upstream", `Too many redirects for "${path}"; not followed.`, "Verify the path with list_site_pages.");

export const pageTooLarge = (path: string, maxBytes: number) =>
  new SurhiresError(
    "upstream",
    `The page at "${path}" is too large (over ${maxBytes} bytes); not read.`,
    "Raise SURHIRES_MAX_PAGE_BYTES only if you trust the origin's page sizes.",
  );

export const upstreamFailure = (path: string, status: number) =>
  new SurhiresError(
    "upstream",
    `surhires.com returned HTTP ${status} for "${path}".`,
    status >= 500
      ? "This is a server-side failure at Surhires. Retry shortly."
      : "Verify the path with list_site_pages.",
    status,
  );

export const parseFailure = (path: string, what: string) =>
  new SurhiresError(
    "parse",
    `Fetched "${path}" but could not extract ${what}.`,
    "The page markup may have changed. Call get_page on the same path to see the raw structured extraction.",
  );

let responseCap = 25_000;

/** Sets the largest serialised result, in characters (from MCP_MAX_RESPONSE_CHARS). */
export function setResponseCap(chars: number): void {
  responseCap = chars;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Finds the longest string, or failing that the longest array, anywhere in a value. */
function largest(value: Json, kind: "string" | "array"): { holder: Json[] | Record<string, Json>; key: string | number; size: number } | undefined {
  let best: { holder: Json[] | Record<string, Json>; key: string | number; size: number } | undefined;
  const visit = (node: Json) => {
    if (node === null || typeof node !== "object") return;
    const entries: [string | number, Json][] = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
    for (const [key, child] of entries) {
      const size =
        kind === "string" && typeof child === "string"
          ? child.length
          : kind === "array" && Array.isArray(child)
            ? JSON.stringify(child).length
            : -1;
      if (size > (best?.size ?? 0)) best = { holder: node, key, size };
      visit(child);
    }
  };
  visit(value);
  return best;
}

const TRIM_MARK = " [...truncated to fit the response size limit]";

/**
 * Shrinks a result until its JSON fits the cap: the longest text field is cut
 * first, then the longest list loses items from its end. The result stays
 * valid JSON with the same shape; it is never cut mid-structure.
 */
export function fitToCap(value: unknown, cap: number): { value: unknown; truncated: boolean } {
  const size = (v: unknown) => JSON.stringify(v, null, 2).length;
  if (size(value) <= cap) return { value, truncated: false };
  const copy = JSON.parse(JSON.stringify(value)) as Json;
  const isObject = copy !== null && typeof copy === "object" && !Array.isArray(copy);
  if (isObject) {
    (copy as Record<string, Json>).response_truncated = true;
    (copy as Record<string, Json>).response_hint =
      "This result was shortened to fit the response size limit. Lower max_chars, or page with limit/offset.";
  }

  for (let guard = 0; guard < 200 && size(copy) > cap; guard += 1) {
    const excess = size(copy) - cap;
    const text = largest(copy, "string");
    if (text && text.size > 200 + TRIM_MARK.length) {
      const holder = text.holder as Record<string | number, Json>;
      const current = holder[text.key] as string;
      const keep = Math.max(200, current.length - excess - TRIM_MARK.length - 16);
      holder[text.key] = current.slice(0, keep) + TRIM_MARK;
      continue;
    }
    const list = largest(copy, "array");
    if (!list) break;
    const arr = (list.holder as Record<string | number, Json>)[list.key] as Json[];
    if (arr.length === 0) break;
    arr.splice(Math.max(0, Math.floor(arr.length * 0.75)), Math.max(1, arr.length - Math.floor(arr.length * 0.75)));
  }
  return { value: copy, truncated: true };
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Wraps a tool handler so every thrown error becomes a clean MCP error result.
 *
 * With `structured: true` (for tools that declare an outputSchema) the value is
 * also returned as `structuredContent`, next to the same JSON as text for
 * clients that only read text. Errors never carry structuredContent; the SDK
 * skips output validation when isError is set.
 */
export function asToolResult<A>(
  handler: (args: A) => Promise<unknown>,
  opts: { structured?: boolean } = {},
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      const value = fitToCap(await handler(args), responseCap).value;
      const text = JSON.stringify(value, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        ...(opts.structured ? { structuredContent: JSON.parse(text) as Record<string, unknown> } : {}),
      };
    } catch (error) {
      if (error instanceof SurhiresError) {
        return { content: [{ type: "text" as const, text: error.toText() }], isError: true };
      }
      // Anything else is a bug or an internal failure: its message may carry
      // internals, so it goes to the operator log (stderr) and the caller gets
      // a generic sentence.
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          msg: "unexpected tool failure",
          detail: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: "Unexpected internal error while handling this request. Retry, or call get_server_diagnostics.",
          },
        ],
        isError: true,
      };
    }
  };
}
