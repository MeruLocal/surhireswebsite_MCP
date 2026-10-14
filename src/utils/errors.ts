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

/** Wraps a tool handler so every thrown error becomes a clean MCP error result. */
export function asToolResult<A>(
  handler: (args: A) => Promise<unknown>,
): (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  return async (args: A) => {
    try {
      const value = await handler(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
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
