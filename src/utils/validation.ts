import { z } from "zod";
import { MARKETS } from "../config.js";
import { SurhiresError } from "./errors.js";

/** Optional per-call market override; falls back to SURHIRES_MARKET. */
export const marketArg = z
  .enum(MARKETS)
  .optional()
  .describe("Market whose localised page to read: in (India), us, gb (United Kingdom), au (Australia). Defaults to SURHIRES_MARKET.");

export const limitArg = (fallback: number, max = 200) =>
  z.coerce.number().int().min(1).max(max).default(fallback).describe(`Maximum results to return (1-${max}).`);

export const offsetArg = z.coerce
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Number of results to skip, for paging through a long list.");

export const queryArg = z
  .string()
  .trim()
  .min(2, "Query must be at least 2 characters.")
  .max(200)
  .describe("Case-insensitive keyword or phrase. Multiple words are matched as independent terms (AND).");

export const slugArg = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase words separated by single hyphens, e.g. 'resume-parsing'.")
  .describe("Page slug, lowercase and hyphenated.");

export const sortArg = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.enum(values).default(fallback).describe(`Sort order: ${values.join(" | ")}.`);

/**
 * Normalises any user-supplied site path to a leading-slash, query-free,
 * fragment-free path on the configured origin.
 *
 * Rejects absolute URLs pointing anywhere other than the configured origin, so
 * a crafted argument cannot turn this server into an open proxy.
 */
export function normalisePath(input: string, baseUrl: string): string {
  const raw = input.trim();
  if (raw === "") throw new SurhiresError("invalid_input", "Path must not be empty.", 'Pass a site path such as "/features/resume-parsing".');

  let path: string;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SurhiresError("invalid_input", `"${raw}" is not a valid URL.`, "Pass a site path such as /pricing.");
    }
    const base = new URL(baseUrl);
    if (url.host !== base.host) {
      throw new SurhiresError(
        "invalid_input",
        `Refusing to fetch "${url.host}": this server only reads ${base.host}.`,
        "Pass a path on the Surhires site, such as /features/resume-parsing.",
      );
    }
    path = url.pathname;
  } else {
    // Strip any query/fragment a caller pasted in, then resolve ".." safely.
    path = new URL(raw.replace(/^\/*/, "/"), "https://placeholder.invalid").pathname;
  }

  path = path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  return path === "" ? "/" : path;
}

/** Splits a query into lowercase terms, all of which must match. */
export function terms(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9+#.]+/i).filter((t) => t.length > 1);
}

/** True when every term appears somewhere in the haystack. */
export function matchesAll(haystack: string, queryTerms: string[]): boolean {
  const lower = haystack.toLowerCase();
  return queryTerms.every((t) => lower.includes(t));
}

/** Simple relevance score: title hits weigh more than body hits. */
export function score(queryTerms: string[], title: string, body: string): number {
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  let total = 0;
  for (const term of queryTerms) {
    if (t.includes(term)) total += 10;
    if (t.startsWith(term)) total += 5;
    const occurrences = b.split(term).length - 1;
    total += Math.min(occurrences, 5);
  }
  return total;
}

export interface Page<T> {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  has_more: boolean;
  results: T[];
}

export function paginate<T>(items: T[], offset: number, limit: number): Page<T> {
  const slice = items.slice(offset, offset + limit);
  return {
    total: items.length,
    offset,
    limit,
    returned: slice.length,
    has_more: offset + slice.length < items.length,
    results: slice,
  };
}
