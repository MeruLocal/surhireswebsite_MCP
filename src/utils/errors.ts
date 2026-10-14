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

export const networkFailure = (path: string, detail: string) =>
  new SurhiresError(
    "network",
    `Could not reach surhires.com for "${path}": ${detail}`,
    "Check network connectivity and that SURHIRES_BASE_URL is correct.",
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

/** Wraps a tool handler so every thrown error becomes a clean MCP error result. */
export function asToolResult<A>(
  handler: (args: A) => Promise<unknown>,
): (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  return async (args: A) => {
    try {
      const value = await handler(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      const text =
        error instanceof SurhiresError
          ? error.toText()
          : `Unexpected failure: ${error instanceof Error ? error.message : String(error)}`;
      return { content: [{ type: "text" as const, text }], isError: true };
    }
  };
}
