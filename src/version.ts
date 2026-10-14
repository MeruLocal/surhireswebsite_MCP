import { createRequire } from "node:module";

/**
 * The single version source: package.json, read once at startup. Resolved
 * relative to this file, which runs from dist/, so "../package.json" is the
 * package root both in a checkout and in the container image (the Dockerfile
 * copies package.json next to dist/).
 */
const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

export const SERVER_VERSION: string = pkg.version;

/** Public website of the product this server describes. */
export const WEBSITE_URL = "https://surhires.com";
