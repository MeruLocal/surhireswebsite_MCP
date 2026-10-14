import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientKey } from "../dist/utils/rate-limit.js";
import { loadConfig } from "../dist/config.js";

describe("RateLimiter", () => {
  test("the 61st hit in a window waits, and a new window resets", () => {
    let now = 1_000_000;
    const rl = new RateLimiter(60, 60_000, () => now);
    for (let i = 0; i < 60; i += 1) assert.equal(rl.hit("a"), 0);
    const wait = rl.hit("a");
    assert.ok(wait > 0 && wait <= 60, `wait ${wait}`);
    assert.equal(rl.hit("b"), 0, "other keys are independent");
    now += 60_000;
    assert.equal(rl.hit("a"), 0);
  });

  test("limit 0 disables limiting", () => {
    const rl = new RateLimiter(0);
    for (let i = 0; i < 500; i += 1) assert.equal(rl.hit("a"), 0);
  });

  test("expired windows are swept once the key map is large", () => {
    let now = 0;
    const rl = new RateLimiter(5, 1_000, () => now, 10);
    for (let i = 0; i < 20; i += 1) rl.hit(`k${i}`);
    now += 2_000;
    rl.hit("fresh");
    assert.equal(rl.size, 1);
  });
});

describe("clientKey", () => {
  const req = (xff?: string) => ({
    headers: xff ? { "x-forwarded-for": xff } : {},
    socket: { remoteAddress: "10.0.0.1" },
  });

  test("0 hops uses the socket address, ignoring X-Forwarded-For", () => {
    assert.equal(clientKey(req("203.0.113.9"), 0), "10.0.0.1");
  });

  test("1 hop uses the right-most X-Forwarded-For entry", () => {
    assert.equal(clientKey(req("198.51.100.7, 203.0.113.9"), 1), "203.0.113.9");
  });

  test("2 hops skip the proxy's own entry (Cloudflare then Apache)", () => {
    // client-sent forged entry, real client, Cloudflare edge address
    assert.equal(clientKey(req("192.0.2.66, 198.51.100.7, 203.0.113.9"), 2), "198.51.100.7");
  });

  test("a header shorter than the hop count falls back to the socket", () => {
    assert.equal(clientKey(req("203.0.113.9"), 2), "10.0.0.1");
  });

  test("falls back to the socket when the header is absent", () => {
    assert.equal(clientKey(req(), 1), "10.0.0.1");
  });

  test("CF-Connecting-IP is not trusted", () => {
    const r = { headers: { "cf-connecting-ip": "192.0.2.1" }, socket: { remoteAddress: "10.0.0.1" } };
    assert.equal(clientKey(r, 1), "10.0.0.1");
  });
});

describe("TRUST_PROXY parsing", () => {
  const hops = (v?: string) =>
    loadConfig({ SURHIRES_BASE_URL: "https://surhires.com", ...(v === undefined ? {} : { TRUST_PROXY: v }) } as NodeJS.ProcessEnv)
      .trustProxy;

  test("unset and 0 mean 0; legacy true/1 mean 1; N means N", () => {
    assert.equal(hops(), 0);
    assert.equal(hops("0"), 0);
    assert.equal(hops("1"), 1);
    assert.equal(hops("true"), 1);
    assert.equal(hops("2"), 2);
    assert.equal(hops("junk"), 0);
  });
});
