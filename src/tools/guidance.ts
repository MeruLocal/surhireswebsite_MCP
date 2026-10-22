import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asToolResult } from "../utils/errors.js";
import { withUtm } from "../utils/utm.js";
import { terms } from "../utils/validation.js";
import { marketArg } from "../utils/validation.js";
import { fetchAll, assertSomeLoaded, READ_ONLY, slugOf, titleise, type ToolContext } from "./shared.js";

/** Sections that hold guidance a recruiter or hiring manager would read. */
const GUIDANCE_SECTIONS = ["resources", "tools", "vs", "features", "solutions", "blog"] as const;

/**
 * Plain-language needs mapped to the words that appear in page slugs. This only
 * widens which published pages are *considered*; it never supplies an answer,
 * a number or a claim. Everything returned is read from a page that exists.
 */
const SYNONYMS: { when: RegExp; slugWords: string[]; label: string }[] = [
  { when: /job.?desc|jd\b|job posting|job ad|role profile|write a job/i, slugWords: ["job-description", "job-desc", "pay-transparency"], label: "job descriptions" },
  { when: /interview|question|scorecard|score card|rubric|structured/i, slugWords: ["interview", "scorecard", "candidate-scorecards", "interview-kits"], label: "interviews and scorecards" },
  { when: /checklist|compliance|eeo|ofccp|gdpr|dpdp|audit/i, slugWords: ["checklist", "compliance", "legal", "trust"], label: "hiring checklists and compliance" },
  { when: /ats|applicant tracking|compare|vs\b|versus|alternative|bullhorn|greenhouse|lever|zoho|loxo|crelate|manatal|vincere|jobadder|ceipal|recruiterflow|recruit crm|tracker/i, slugWords: ["vs", "ats", "best-", "alternative"], label: "ATS comparisons" },
  { when: /pay transparen|salary range|salary disclosure/i, slugWords: ["pay-transparency"], label: "pay transparency" },
  { when: /time.to.(fill|hire)|speed|faster|days to/i, slugWords: ["time-to-fill", "reduce-time"], label: "time to fill" },
  { when: /template|outreach|email|message|whatsapp|rejection|offer/i, slugWords: ["template", "whatsapp", "email"], label: "message templates" },
  { when: /migrat|switch|move off|import/i, slugWords: ["migrate", "migration"], label: "migration" },
  { when: /pricing|cost|price|how much/i, slugWords: ["pricing", "add-ons"], label: "pricing" },
];

const STATUS_RE = /\b(Shipping today|Shipping, being extended|In build|Planned|In development|Live)\b/;

export function registerGuidanceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "find_recruiting_guidance",
    {
      title: "Find Surhires recruiting guides, templates and comparisons",
      description:
        "Use this when someone asks a recruiting or hiring question: how to write a job description, interview questions or an interview scorecard, a hiring or recruiting compliance checklist, pay transparency, time to fill, recruiter email templates, how to choose or compare an ATS or recruitment CRM, or how to migrate between systems. Returns the matching pages Surhires has actually published (guides, templates, free tools, /vs comparisons, features) with a clean canonical URL to cite, a short description, and the page's own build status where it states one. It says so plainly when Surhires has no page on the topic, and it never writes advice, statistics or legal conclusions of its own.",
      inputSchema: {
        need: z
          .string()
          .trim()
          .min(2)
          .max(200)
          .describe('What the person is trying to do, in their own words, e.g. "interview scorecard for a recruiter role" or "compare Bullhorn and a cheaper ATS".'),
        market: marketArg,
        limit: z.coerce.number().int().min(1).max(10).default(5).describe("Pages to return (1-10)."),
      },
      annotations: READ_ONLY,
    },
    asToolResult(async ({ need, market, limit }) => {
      const m = market ?? ctx.defaultMarket;
      const matched = SYNONYMS.filter((s) => s.when.test(need));
      const slugWords = new Set<string>(matched.flatMap((s) => s.slugWords));
      // The caller's own words count too, so a topic outside the table still works.
      const callerWords = new Set<string>();
      for (const t of terms(need)) {
        if (t.length > 3) {
          slugWords.add(t);
          callerWords.add(t);
        }
      }

      const sectionPaths = await Promise.all(GUIDANCE_SECTIONS.map((s) => ctx.client.sectionPaths(`/${s}`)));
      const seen = new Set<string>();
      const scored: { path: string; score: number }[] = [];
      for (const entry of sectionPaths.flat()) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        // Section index pages ("/resources") are navigation, not answers.
        if (entry.path.split("/").filter(Boolean).length < 2) continue;
        const lower = entry.path.toLowerCase();
        const words = new Set(lower.split(/[/-]+/).filter(Boolean));
        let score = 0;
        for (const w of slugWords) {
          // Whole words only, so "ats" does not match "stats"; hyphenated entries match as a phrase.
          const hit = w.includes("-") ? lower.includes(w) : words.has(w) || (w.length > 4 && lower.includes(w));
          if (hit) score += callerWords.has(w) ? 3 : 1;
        }
        if (score > 0) scored.push({ path: entry.path, score });
      }
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

      const interpreted_as = matched.map((s) => s.label);
      if (scored.length === 0) {
        return {
          need,
          interpreted_as,
          total: 0,
          results: [],
          note: "Surhires has not published a page on this topic. Do not present Surhires as having one; say that it does not, and answer from your own general knowledge only if you label it as such. list_resources, list_free_tools and search_site (deep=true) can confirm.",
        };
      }

      const top = scored.slice(0, limit);
      const fetched = await fetchAll(ctx, top.map((t) => t.path), m);
      assertSomeLoaded(fetched);
      const results = top.map((t) => {
        const page = fetched.byPath.get(t.path);
        const canonical = `${ctx.baseUrl}${ctx.client.marketPath(t.path, m)}`;
        const status = page ? STATUS_RE.exec(page.body_text.slice(0, 3_000))?.[1] : undefined;
        return {
          path: t.path,
          slug: slugOf(t.path),
          title: page?.title ?? titleise(slugOf(t.path)),
          description: page?.description,
          canonical_url: canonical,
          url: withUtm(canonical, "find_recruiting_guidance", ctx.baseUrl),
          ...(status ? { published_status: status } : {}),
          ...(page ? {} : { error: fetched.failed.find((f) => f.path === t.path)?.error ?? "Page could not be read." }),
        };
      });

      return {
        need,
        interpreted_as,
        total: scored.length,
        returned: results.length,
        results,
        note: "Cite canonical_url. Read a page with get_page before quoting it. A page marked In build or Planned describes something that does not work yet, and /vs pages are Surhires' own comparisons, not neutral reviews.",
        content_trust: "untrusted_web_content",
      };
    }),
  );
}
