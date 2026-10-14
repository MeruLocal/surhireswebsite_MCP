import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asToolResult, parseFailure } from "../utils/errors.js";
import { extractOrganization } from "../clients/extract.js";
import { marketArg } from "../utils/validation.js";
import { presentPage, READ_ONLY, slugOf, type ToolContext } from "./shared.js";
import { ListOutput } from "./schemas.js";

/**
 * Company, trust and integration-status tools.
 *
 * get_api_and_mcp_status exists because the single most load-bearing fact
 * about integrating with Surhires is that there is nothing to integrate with
 * yet. Rather than hardcode that conclusion, the tool reads the three pages
 * that state it and returns their current text, so the answer updates itself
 * the day Surhires ships an API.
 */
export function registerCompanyTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_company_info",
    {
      title: "Get Surhires company information",
      description:
        "Returns the operating company behind Surhires from the site's Organization structured data: legal name, registered address, sales contact point, logo and the areas it serves. Useful for due diligence on who you would be contracting with.",
      inputSchema: { market: marketArg },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ market }) => {
      const html = await ctx.client.getText("/", market);
      const org = extractOrganization(html);
      if (!org) throw parseFailure("/", "the Organization structured data");

      const contacts = Array.isArray(org.contactPoint) ? (org.contactPoint as Record<string, unknown>[]) : [];
      const address = (org.address ?? {}) as Record<string, unknown>;

      return {
        name: org.name,
        legal_name: org.legalName,
        description: org.description,
        url: org.url,
        address: {
          street: address.streetAddress,
          locality: address.addressLocality,
          region: address.addressRegion,
          postal_code: address.postalCode,
          country: address.addressCountry,
        },
        contact_points: contacts.map((c) => ({
          type: c.contactType,
          telephone: c.telephone,
          email: c.email,
          areas_served_count: Array.isArray(c.areaServed) ? c.areaServed.length : undefined,
        })),
        same_as: org.sameAs,
        note: "Read from the public site's own structured data.",
      };
    }),
  );

  server.registerTool(
    "get_api_and_mcp_status",
    {
      title: "Check whether Surhires offers an API, MCP server or Zapier app",
      description:
        "Reads the pages where Surhires states the status of its programmatic surfaces -- /mcp-server, /whats-shipping and /integrations/zapier -- and returns their current published text plus FAQ entries. Call this before assuming any Surhires API exists: as of this server's last verification, Surhires published no REST API, API keys or developer docs for tenant data; this server is the official Surhires MCP server for public website content.",
      inputSchema: {
        market: marketArg,
        max_chars: z.coerce.number().int().min(200).max(40_000).default(6_000),
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ market, max_chars }) => {
      const targets = ["/mcp-server", "/whats-shipping", "/integrations/zapier"];
      const settled = await Promise.allSettled(targets.map((p) => ctx.client.getPage(p, market)));

      return {
        verified_at_build: "2026-10-13",
        summary: [
          "No public REST API, API key flow, OAuth app or developer documentation was published on surhires.com.",
          "docs.surhires.com, developers.surhires.com and api.surhires.com did not resolve in DNS.",
          "robots.txt disallows /api/ for every user agent, so that surface is not readable here.",
          "No authenticated MCP surface for tenant data was published; this server is the official Surhires MCP server for public website content.",
          "The Zapier app was described as in development and not usable.",
        ],
        pages: settled.map((result, i) =>
          result.status === "fulfilled"
            ? presentPage(result.value, { maxChars: max_chars })
            : {
                path: ctx.client.marketPath(targets[i]!, market),
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                note: "Page unavailable. If it now 404s, Surhires may have restructured these pages -- re-verify before concluding anything.",
              },
        ),
        what_this_means:
          "This MCP server reads Surhires' public website only. It cannot search your candidates, post jobs, submit applications or read your pipeline, because Surhires exposes no authenticated API to do so. The page text above is the live answer; if it now says an API has shipped, those tools can be built.",
      };
    }),
  );

  server.registerTool(
    "get_integration_status",
    {
      title: "Check whether a Surhires integration is live",
      description:
        "Answers whether a named integration actually works today. Surhires publishes a page for every planned connector, and several say plainly that they are in build or gated on partner access -- so the existence of a page is not evidence the connector is usable. This tool returns the page's status language and its FAQ, where that question is usually answered first.",
      inputSchema: {
        integration: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .describe('Integration slug, e.g. "naukri", "indeed", "linkedin-recruiter", "zapier", "slack".'),
        market: marketArg,
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ integration, market }) => {
      const entries = await ctx.client.sectionPaths("/integrations");
      const wanted = integration.toLowerCase().replace(/\s+/g, "-");
      const hit = entries.find((e) => slugOf(e.path) === wanted);
      if (!hit) {
        const near = entries.map((e) => slugOf(e.path)).filter((s) => s.includes(wanted) || wanted.includes(s));
        return {
          integration: wanted,
          found: false,
          note: `Surhires publishes no integration page for "${wanted}".`,
          closest_slugs: near.slice(0, 8),
          hint: "Call list_integrations for the full list.",
        };
      }

      const page = await ctx.client.getPage(hit.path, market);

      // Surface the sentences that speak to status, so the caller does not have
      // to read the whole page to find out whether it works.
      const STATUS_LANGUAGE =
        /\b(in build|not (?:usable|connected|shipping|available)|planned|gated|waitlist|coming|shipp(?:ed|ing|s)|live today|works today|available today|partner access|wave \d)\b/i;
      const statusSentences = page.body_text
        .split(/(?<=[.!?])\s+/)
        .filter((s) => STATUS_LANGUAGE.test(s))
        .slice(0, 12)
        .map((s) => s.trim());

      return {
        integration: slugOf(hit.path),
        found: true,
        path: page.path,
        title: page.heading,
        description: page.description,
        date_modified: page.date_modified,
        status_sentences: statusSentences,
        faqs: page.faqs,
        hint: "The first FAQ entry on these pages usually answers 'is this connected today?' directly. Read it before relying on the connector.",
      };
    }),
  );

  server.registerTool(
    "get_trust_and_security",
    {
      title: "Get Surhires security and compliance posture",
      description:
        "Reads Surhires' /security and /trust-center pages: data handling, subprocessors, certification status and compliance claims. Note that Surhires describes its SOC 2 work as a readiness programme rather than a completed certification, so read the wording carefully rather than taking a badge at face value.",
      inputSchema: {
        market: marketArg,
        max_chars: z.coerce.number().int().min(200).max(60_000).default(8_000),
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ market, max_chars }) => {
      const targets = ["/security", "/trust-center"];
      const settled = await Promise.allSettled(targets.map((p) => ctx.client.getPage(p, market)));
      return {
        pages: settled.map((result, i) =>
          result.status === "fulfilled"
            ? presentPage(result.value, { maxChars: max_chars })
            : {
                path: ctx.client.marketPath(targets[i]!, market),
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
              },
        ),
      };
    }),
  );

  server.registerTool(
    "list_legal_documents",
    {
      title: "List Surhires legal and compliance pages",
      description:
        "Lists the pages under /legal -- terms, privacy, DPA, GDPR, India DPDPA, CCPA, EEO/OFCCP, TCPA/CAN-SPAM, cookies, subprocessors, accessibility. Read any of them in full with get_page.",
      inputSchema: {},
      annotations: READ_ONLY,
      outputSchema: ListOutput,
    },
    asToolResult(async () => {
      const entries = await ctx.client.sectionPaths("/legal");
      return {
        total: entries.length,
        results: entries.map((e) => ({ slug: slugOf(e.path), path: e.path, last_modified: e.last_modified })),
        hint: 'Read one with get_page, e.g. path="/legal/dpdpa".',
      };
    }, { structured: true }),
  );

  server.registerTool(
    "get_server_diagnostics",
    {
      title: "Diagnose this MCP server",
      description:
        "Reports this server's own configuration and connectivity: which origin and market it reads, cache state, and whether surhires.com is reachable right now. Call this first when a tool is failing, to tell a network or configuration problem apart from a page that has genuinely changed.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    asToolResult(async () => {
      let reachable = false;
      let indexed = 0;
      let error: string | undefined;
      try {
        indexed = (await ctx.client.getSiteIndex()).length;
        reachable = indexed > 0;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      return {
        default_market: ctx.defaultMarket,
        cache: ctx.client.cacheStats(),
        surhires_reachable: reachable,
        pages_in_sitemap: indexed,
        ...(error ? { error } : {}),
        scope: "Public surhires.com pages only. No credentials are held, and /api/ is refused as robots-disallowed.",
      };
    }),
  );
}
