import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientKey } from "../dist/utils/rate-limit.js";

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

  test("uses the socket address without TRUST_PROXY, ignoring X-Forwarded-For", () => {
    assert.equal(clientKey(req("203.0.113.9"), false), "10.0.0.1");
  });

  test("uses the right-most X-Forwarded-For hop with TRUST_PROXY", () => {
    assert.equal(clientKey(req("198.51.100.7, 203.0.113.9"), true), "203.0.113.9");
  });

  test("falls back to the socket when the header is absent", () => {
    assert.equal(clientKey(req(), true), "10.0.0.1");
  });
});
