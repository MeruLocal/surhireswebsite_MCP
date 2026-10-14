import type { FetchLike } from "../dist/clients/surhires-client.js";
import { RESPONSES } from "./fixtures.ts";

export interface MockFetch {
  fetch: FetchLike;
  calls: string[];
  /** Queue a scripted outcome for the next request to a path. */
  script: (path: string, outcomes: Outcome[]) => void;
}

export type Outcome =
  | { kind: "status"; status: number; headers?: Record<string, string> }
  | { kind: "network"; message: string }
  | { kind: "abort" }
  | { kind: "body"; body: string };

/**
 * Deterministic stand-in for the site. Returns fixture HTML for known paths,
 * 404 for anything else, and whatever a test scripts for a given path.
 */
export function createMockFetch(responses: Record<string, string> = RESPONSES): MockFetch {
  const calls: string[] = [];
  const scripted = new Map<string, Outcome[]>();

  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input).pathname.replace(/(.)\/$/, "$1");
    calls.push(path);

    const queue = scripted.get(path);
    const next = queue?.shift();
    if (queue && queue.length === 0) scripted.delete(path);

    if (next) {
      if (next.kind === "network") throw new Error(next.message);
      if (next.kind === "abort") {
        // Mirror what fetch does when an AbortSignal fires.
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      if (next.kind === "status") {
        return {
          ok: next.status < 400,
          status: next.status,
          text: async () => "",
          headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => next.body,
        headers: { get: () => null },
      };
    }

    if (init?.signal?.aborted) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }

    const body = responses[path];
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => "", headers: { get: () => null } };
    }
    return { ok: true, status: 200, text: async () => body, headers: { get: () => null } };
  };

  return {
    fetch,
    calls,
    script: (path, outcomes) => scripted.set(path, [...outcomes]),
  };
}
