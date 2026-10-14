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
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./utils/logger.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Tool names, read from a throwaway server instance so the page cannot go stale. */
function listToolNames(config: ReturnType<typeof loadConfig>): string[] {
  const { server, toolNames } = buildServer({ config, logger: createLogger({ logLevel: "error" }) });
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
function sendStatusPage(res: ServerResponse, config: ReturnType<typeof loadConfig>): void {
  const names = listToolNames(config);

  const body = renderShell(
    "Surhires Website Knowledge MCP Server",
    `
<h1>Surhires Website Knowledge MCP Server</h1>

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

<p>Surhires publishes no public API, no API keys and no developer documentation, and
<code>robots.txt</code> disallows <code>/api/</code> for every user agent. Its own pages
describe the official Surhires MCP server as planned rather than shipping. This server
therefore reads the published website only: it cannot search candidates, post or edit jobs,
submit applications or read a pipeline. Call <code>get_api_and_mcp_status</code> for the live
wording from Surhires' own pages.</p>

<p>Reading <strong>${escapeHtml(config.baseUrl)}</strong> for the
<strong>${escapeHtml(config.market)}</strong> market, with ${names.length} tools registered.</p>

<h2>Try it</h2>
<pre>curl -X POST http://127.0.0.1:${config.port}/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</pre>

<h2>Tools (${names.length})</h2>
<ul class="tools">${names.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>

<hr/>
<p class="meta">You are seeing this page because a browser sends <code>GET</code>. The protocol
endpoint speaks JSON-RPC over <code>POST</code> and answers <code>405</code> to anything else
&mdash; expected, not a fault. Content belongs to Surhires / Soor LLC; this is an unofficial
client, not affiliated with or endorsed by Surhires.</p>
`,
  );

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}


async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

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
        sendStatusPage(res, config);
        return;
      }

      if (url.pathname === "/version") {
        sendJson(res, 200, { name: SERVER_NAME, version: SERVER_VERSION });
        return;
      }

      // Discovery document, so a client can learn the endpoint and tool list
      // without a round trip through the protocol.
      if (url.pathname === "/.well-known/mcp.json") {
        sendJson(res, 200, {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          description:
            "Read-only MCP server over the public Surhires website: pricing, features, integrations, competitor comparisons, blog and compliance posture. Holds no credentials and performs no ATS actions.",
          transport: { type: "streamable-http", url: `/mcp`, methods: ["POST"] },
          authentication: { required: false, note: "No API key is required and none should be sent." },
          capabilities: { tools: { listChanged: true } },
          tools: listToolNames(config),
          documentation: "/",
        });
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
          sendStatusPage(res, config);
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

      // One server + transport per request: stateless, so nothing leaks between callers.
      const { server } = buildServer({ config, logger: log });
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
          ...config.allowedHosts,
        ],
      });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, await readJsonBody(req));
      } catch (error) {
        log.error("request failed", { detail: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) {
          sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
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
