/**
 * Black-box tests of the HTTP entry point: abuse hardening (Origin allowlist,
 * rate limit, body cap), JSON-RPC parse errors and the advertised endpoint.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHttp, MCP_HEADERS, toolsList, type RunningServer } from "./http-harness.ts";

describe("HTTP hardening (defaults)", () => {
  let srv: RunningServer;
  before(async () => {
    srv = await startHttp();
  });
  after(async () => {
    await srv.stop();
  });

  test("a POST with no Origin (non-browser client) is served", async () => {
    const res = await fetch(`${srv.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: toolsList });
    assert.equal(res.status, 200);
  });

  test("a POST from a foreign browser Origin gets 403", async () => {
    const res = await fetch(`${srv.base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: "http://evil.example" },
      body: toolsList,
    });
    assert.equal(res.status, 403);
  });

  test("a POST from an allowed Origin is served", async () => {
    const res = await fetch(`${srv.base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: `http://127.0.0.1:${srv.port}` },
      body: toolsList,
    });
    assert.equal(res.status, 200);
  });

  test("a 2 MB body gets 413 with a JSON-RPC error", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(2 * 1024 * 1024) } });
    const res = await fetch(`${srv.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: big });
    assert.equal(res.status, 413);
    const json = (await res.json()) as { error: { code: number } };
    assert.equal(typeof json.error.code, "number");
  });

  test("a malformed body gets 400 and JSON-RPC code -32700", async () => {
    const res = await fetch(`${srv.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: "{bad" });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error: { code: number } };
    assert.equal(json.error.code, -32700);
  });

  test("the manifest counts tools instead of listing them, without listChanged", async () => {
    const res = await fetch(`${srv.base}/.well-known/mcp.json`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.tools, undefined);
    assert.equal(json.capabilities.tools.listChanged, undefined);
    const list = await fetch(`${srv.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: toolsList });
    const text = await list.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(text.startsWith("{") ? text : dataLine!.slice("data: ".length));
    assert.equal(json.tool_count, payload.result.tools.length);
  });

  test("/version advertises the endpoint and transport", async () => {
    const json = (await (await fetch(`${srv.base}/version`)).json()) as Record<string, string>;
    assert.equal(json.endpoint, "/mcp");
    assert.equal(json.transport, "streamable-http");
  });
});

describe("HTTP rate limit", () => {
  let srv: RunningServer;
  before(async () => {
    srv = await startHttp({ MCP_RATE_LIMIT_PER_MIN: "2" });
  });
  after(async () => {
    await srv.stop();
  });

  test("the third POST in a minute gets 429 with Retry-After", async () => {
    const post = () => fetch(`${srv.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: toolsList });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const third = await post();
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get("retry-after")) > 0);
  });
});

describe("advertised public endpoint", () => {
  let srv: RunningServer;
  before(async () => {
    srv = await startHttp({ MCP_PUBLIC_BASE_URL: "https://mcp.example.test", MCP_ALLOWED_HOSTS: "*" });
  });
  after(async () => {
    await srv.stop();
  });

  test("the status page shows the configured URL, not localhost", async () => {
    const html = await (await fetch(`${srv.base}/`)).text();
    assert.match(html, /https:\/\/mcp\.example\.test\/mcp/);
    assert.doesNotMatch(html, /127\.0\.0\.1:\d+\/mcp/);
  });

  test("the manifest transport URL is absolute", async () => {
    const json = (await (await fetch(`${srv.base}/.well-known/mcp.json`)).json()) as { transport: { url: string } };
    assert.equal(json.transport.url, "https://mcp.example.test/mcp");
  });

  test("a forged Host header does not change the advertised URL", async () => {
    const html = await (await fetch(`${srv.base}/`, { headers: { host: "evil.example" } })).text();
    assert.match(html, /https:\/\/mcp\.example\.test\/mcp/);
    assert.doesNotMatch(html, /evil\.example/);
  });
});
