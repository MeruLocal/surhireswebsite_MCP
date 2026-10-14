#!/usr/bin/env node
/**
 * Streamable HTTP entry point, for running this server remotely instead of as a
 * Claude Desktop child process.
 *
 * Stateless by design: each POST gets a fresh server and transport, which is
 * safe here because every tool is a read of a public page and holds no session
 * state beyond an in-process cache. That removes session handling as a source
 * of bugs and lets the process sit behind any load balancer.
 *
 * It binds to 127.0.0.1 by default. Exposing it publicly is your decision and
 * needs a reverse proxy terminating TLS and enforcing authentication -- this
 * server has no auth of its own because it holds no secrets and reads only
 * public pages.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, SERVER_NAME, SERVER_VERSION, WEBSITE_URL } from "./server.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger } from "./utils/logger.js";
import { SurhiresClient } from "./clients/surhires-client.js";
import { clientKey, RateLimiter } from "./utils/rate-limit.js";

/** JSON-RPC requests here are a few hundred bytes; 1 MB is generous. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The public host this server is meant to be deployed at (founder to confirm). */
const DEFAULT_PUBLIC_HOST = "mcp.surhires.com";

class BodyTooLargeError extends Error {}

/** After the cap is hit, keep reading (and discarding) at most this much more. */
const MAX_DRAIN_BYTES = 8 * MAX_BODY_BYTES;

/**
 * Event-based body read. When the body is over the cap (declared or streamed)
 * it stops buffering and rejects, but keeps draining the rest of the upload so
 * the client can finish sending and read the 413 instead of seeing a reset.
 * The drain is bounded; past that the request is destroyed.
 */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    let chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    const overflow = () => {
      if (tooLarge) return;
      tooLarge = true;
      chunks = [];
      reject(new BodyTooLargeError());
    };

    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) overflow();

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) {
        if (size > MAX_BODY_BYTES + MAX_DRAIN_BYTES) req.destroy();
        return;
      }
      if (size > MAX_BODY_BYTES) {
        overflow();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!tooLarge) reject(err);
    });
    req.on("close", () => {
      if (!tooLarge && !req.complete) reject(new Error("request closed before the body was read"));
    });
  });
}

const sendJson = (
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
};

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** The base URL to advertise. From config only, never from Host/X-Forwarded-Host. */
const advertisedBase = (config: Config): string => config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`;

/** Browser Origins allowed to call /mcp. "*" in the list allows any. */
function allowedOrigins(config: Config): string[] {
  const list = [
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `https://${DEFAULT_PUBLIC_HOST}`,
    ...config.allowedOrigins,
  ];
  if (config.publicBaseUrl) list.push(new URL(config.publicBaseUrl).origin);
  return list;
}

/** Tool names, read from a throwaway server instance so the page cannot go stale. */
function listToolNames(config: Config, client: SurhiresClient): string[] {
  const { server, toolNames } = buildServer({ config, logger: createLogger({ logLevel: "error" }), client });
  void server.close();
  return toolNames;
}


/** Shared page shell, so every browser-facing route renders in one skin. */
function renderShell(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex"/>
<style>
 :root{--bg:#fff;--fg:#14130f;--muted:#5f5c54;--line:#e3e1db;--code:#f4f3ef;--link:#0b5ed7;--warn:#8a5a00}
 @media(prefers-color-scheme:dark){:root{--bg:#141412;--fg:#f2f0ea;--muted:#a5a199;--line:#302e2a;--code:#201f1d;--link:#7aa7ff;--warn:#d7a449}}
 *{box-sizing:border-box}
 body{background:var(--bg);color:var(--fg);margin:0;padding:64px 16px 96px;
  font:18px/1.65 Georgia,"Times New Roman",ui-serif,serif;-webkit-font-smoothing:antialiased}
 main{max-width:760px;margin:0 auto}
 h1{font-size:2.25rem;line-height:1.2;font-weight:700;margin:0 0 28px;letter-spacing:-.01em}
 h2{font-size:1.125rem;margin:40px 0 12px;font-weight:700}
 p{margin:0 0 20px}
 a{color:var(--link);text-decoration:underline;text-underline-offset:2px}
 code{background:var(--code);border-radius:4px;padding:1px 6px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.82em}
 pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:16px;
  overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.78rem;line-height:1.55;margin:0 0 20px}
 .meta{font-size:.95rem;color:var(--muted)}
 .caution{font-size:.82rem;line-height:1.6;color:var(--warn);margin:0 0 24px}
 ul.tools{columns:2;column-gap:32px;padding-left:20px;margin:0 0 20px}
 @media(max-width:600px){ul.tools{columns:1} h1{font-size:1.75rem} body{padding:40px 16px 64px}}
 ul.tools li{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.76rem;break-inside:avoid;margin-bottom:3px}
 hr{border:0;border-top:1px solid var(--line);margin:40px 0}
</style></head><body><main>
${content}
</main></body></html>`;
}

/**
 * A human-readable landing page, for when someone opens the server in a browser.
 * Not part of the MCP protocol -- it exists so a GET does not look like a failure,
 * and so the scope of this server is stated plainly to whoever lands on it.
 */
function sendStatusPage(res: ServerResponse, config: Config, names: string[]): void {

  const body = renderShell(
    "Surhires MCP Server",
    `
<h1>Surhires MCP Server</h1>

<p>Read-only Surhires website mirror (product knowledge: pricing, features, integrations,
comparisons, competitor pages, blog and compliance posture). Connect via the Streamable HTTP
endpoint at <code>/mcp</code>. No API key is required &mdash; this server holds no customer
data and performs no ATS actions.</p>

<p class="meta">Status: <a href="/version">/version</a> &middot;
Discovery: <a href="/.well-known/mcp.json">/.well-known/mcp.json</a> &middot;
Health: <a href="/health">/health</a> &middot;
Tools: <code>POST /mcp</code> &rarr; <code>tools/list</code></p>

<p class="caution">This is not a customer ATS API. It holds no candidate, client or pipeline
data, performs no ATS actions, and needs no API key &mdash; never send one here.</p>

<p>This is the official Surhires MCP server for public product knowledge. It reads the
published website only: it cannot search candidates, post or edit jobs, submit applications
or read a pipeline. Tenant data lives behind a login at <code>app.surhires.com</code>, no public
API for it is published, and <code>robots.txt</code> disallows <code>/api/</code> for every user
agent. Call <code>get_api_and_mcp_status</code> for the live wording from Surhires' own pages.</p>

<p>Reading <strong>${escapeHtml(config.baseUrl)}</strong> for the
<strong>${escapeHtml(config.market)}</strong> market, with ${names.length} tools registered.</p>

<h2>Try it</h2>
<pre>curl -X POST ${escapeHtml(advertisedBase(config))}/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</pre>

<h2>Tools (${names.length})</h2>
<ul class="tools">${names.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>

<hr/>
<p class="meta">You are seeing this page because a browser sends <code>GET</code>. The protocol
endpoint speaks JSON-RPC over <code>POST</code> and answers <code>405</code> to anything else
&mdash; expected, not a fault. Content belongs to Surhires / Soor LLC.</p>
`,
  );

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}


async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);

  // One client for the life of the process: its page cache, request
  // coalescing and outbound concurrency limit then work across requests.
  const client = new SurhiresClient(config, log);
  // Built once: the tool set is fixed for the life of the process, so GET / and
  // the discovery document must not construct a server per request.
  const toolNames = listToolNames(config, client);
  const limiter = new RateLimiter(config.rateLimitPerMin);
  const origins = allowedOrigins(config);
  const anyOrigin = config.allowedOrigins.includes("*");

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      // /healthz is kept as an alias so anything already pointed at it keeps working.
      if (url.pathname === "/health" || url.pathname === "/healthz") {
        sendJson(res, 200, {
          status: "ok",
          server: SERVER_NAME,
          version: SERVER_VERSION,
          market: config.market,
          base_url: config.baseUrl,
        });
        return;
      }

      if (url.pathname === "/" && req.method === "GET") {
        sendStatusPage(res, config, toolNames);
        return;
      }

      if (url.pathname === "/version") {
        sendJson(res, 200, {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          endpoint: "/mcp",
          transport: "streamable-http",
        });
        return;
      }

      // Discovery document, so a client can learn the endpoint and tool list
      // without a round trip through the protocol.
      if (url.pathname === "/.well-known/mcp.json") {
        // tools/list is the one source of tool names; the manifest only counts
        // them. Readable cross-origin so browser-based inspectors can fetch it.
        sendJson(
          res,
          200,
          {
            name: SERVER_NAME,
            version: SERVER_VERSION,
            websiteUrl: WEBSITE_URL,
            description:
              "Official Surhires MCP server: read-only access to the public Surhires website (pricing, features, integrations, competitor comparisons, blog and compliance posture). Holds no credentials and performs no ATS actions.",
            transport: {
              type: "streamable-http",
              url: config.publicBaseUrl ? `${config.publicBaseUrl}/mcp` : "/mcp",
              methods: ["POST"],
            },
            authentication: { required: false, note: "No API key is required and none should be sent." },
            // The tool set is fixed at build and this transport is stateless, so
            // no list-changed notification is ever sent.
            capabilities: { tools: {} },
            tool_count: toolNames.length,
            documentation: "/",
          },
          { "access-control-allow-origin": "*" },
        );
        return;
      }

      if (url.pathname !== "/mcp") {
        sendJson(res, 404, { error: "Not found. The MCP endpoint is POST /mcp." });
        return;
      }

      if (req.method !== "POST") {
        const accept = req.headers.accept ?? "";
        // A real MCP client opening an SSE stream still gets 405: this server is
        // stateless and has no standalone stream to attach to. A browser, which
        // asks for HTML, gets a readable status page instead of a bare error.
        if (req.method === "GET" && accept.includes("text/html")) {
          sendStatusPage(res, config, toolNames);
          return;
        }
        res.writeHead(405, { allow: "POST", "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Method not allowed. This endpoint speaks JSON-RPC over POST.",
            hint: "A browser address bar sends GET, which is why you are seeing this. Open / for a status page, or POST a JSON-RPC request to /mcp.",
          }),
        );
        return;
      }

      // A browser on another site must not be able to drive this server through
      // a visitor. Non-browser MCP clients send no Origin and are unaffected.
      const origin = req.headers.origin;
      if (origin !== undefined && !anyOrigin && !origins.includes(origin.replace(/\/+$/, ""))) {
        sendJson(res, 403, rpcError(-32000, "Forbidden: this Origin is not allowed to call this server."));
        return;
      }

      const wait = limiter.hit(clientKey(req, config.trustProxy));
      if (wait > 0) {
        sendJson(res, 429, rpcError(-32000, `Rate limit exceeded. Retry after ${wait}s.`), {
          "retry-after": String(wait),
        });
        return;
      }

      let raw: string | undefined;
      try {
        raw = await readBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, rpcError(-32600, `Request body too large (limit ${MAX_BODY_BYTES} bytes).`));
          return;
        }
        log.error("request read failed", { detail: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal server error"));
        return;
      }

      let body: unknown;
      try {
        body = raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        // The caller's own malformed JSON is a client error, not a server fault.
        sendJson(res, 400, rpcError(-32700, "Parse error"));
        return;
      }

      // One server + transport per request: stateless, so nothing leaks between callers.
      const { server } = buildServer({ config, logger: log, client, deepPageCap: config.httpDeepMaxPages });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // In a container or behind a proxy the Host header is the public name,
        // which rebinding protection rejects unless it is listed. MCP_ALLOWED_HOSTS
        // adds those names; "*" turns the check off for a trusted network.
        enableDnsRebindingProtection: !config.allowedHosts.includes("*"),
        allowedHosts: [
          `${config.httpHost}:${config.port}`,
          `localhost:${config.port}`,
          `127.0.0.1:${config.port}`,
          DEFAULT_PUBLIC_HOST,
          `${DEFAULT_PUBLIC_HOST}:443`,
          ...(config.publicBaseUrl ? [new URL(config.publicBaseUrl).host] : []),
          ...config.allowedHosts,
        ],
      });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        log.error("request failed", { detail: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal server error"));
      }
    })();
  });

  http.listen(config.port, config.httpHost, () => {
    log.info("listening on http", {
      url: `http://${config.httpHost}:${config.port}/mcp`,
      market: config.market,
    });
  });

  const shutdown = () => http.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
