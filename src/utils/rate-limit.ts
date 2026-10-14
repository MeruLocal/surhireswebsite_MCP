import type { IncomingMessage } from "node:http";

/**
 * Fixed-window rate limiter keyed by client. In-process only: with several
 * replicas each enforces its own window, which is acceptable for a read-only
 * server whose aim is to stop one caller driving unbounded origin fetches.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 1_000,
  ) {}

  /** Records a hit. Returns the seconds to wait when over the limit, else 0. */
  hit(key: string): number {
    if (this.limit <= 0) return 0;
    const t = this.now();
    if (this.windows.size > this.maxKeys) this.sweep(t);

    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= this.limit) return 0;
    return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
  }

  /** Drops expired windows so the key map cannot grow without bound. */
  private sweep(t: number): void {
    for (const [k, w] of this.windows) {
      if (t - w.start >= this.windowMs) this.windows.delete(k);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * The key a request is limited under. With `trustedHops` = 0 this is the
 * socket address. With N trusted proxy hops it is the Nth X-Forwarded-For
 * entry counting from the right (each trusted proxy appended one entry, and
 * anything a client sends sits further left, so it cannot be forged). When the
 * header has fewer than N entries it falls back to the socket address.
 * CF-Connecting-IP is deliberately not trusted.
 */
export function clientKey(
  req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string } },
  trustedHops: number,
): string {
  if (trustedHops > 0) {
    const raw = req.headers["x-forwarded-for"];
    const header = Array.isArray(raw) ? raw.join(",") : raw;
    const hops = (header ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    const picked = hops[hops.length - trustedHops];
    if (hops.length >= trustedHops && picked) return picked;
  }
  return req.socket.remoteAddress ?? "unknown";
}
