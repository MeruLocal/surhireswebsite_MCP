/**
 * Fixtures mirroring the real shape of surhires.com responses, reduced to the
 * parts the parsers read. The JSON-LD structure here was copied from live
 * pages on 2026-10-13 so the tests fail if the extractor drifts from reality.
 */

export const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://surhires.com/sitemaps/pages.xml</loc></sitemap>
  <sitemap><loc>https://surhires.com/blog/sitemap.xml</loc></sitemap>
</sitemapindex>`;

export const PAGES_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://surhires.com</loc></url>
  <url><loc>https://surhires.com/pricing</loc><lastmod>2026-09-08</lastmod></url>
  <url><loc>https://surhires.com/features/resume-parsing</loc><lastmod>2026-09-08</lastmod></url>
  <url><loc>https://surhires.com/features/interview-scheduling</loc></url>
  <url><loc>https://surhires.com/integrations/naukri</loc></url>
  <url><loc>https://surhires.com/integrations/slack</loc></url>
  <url><loc>https://surhires.com/solutions/staffing-agencies</loc></url>
  <url><loc>https://surhires.com/vs/bullhorn</loc></url>
  <url><loc>https://surhires.com/legal/dpdpa</loc></url>
  <url><loc>https://surhires.com/mcp-server</loc></url>
  <url><loc>https://surhires.com/whats-shipping</loc></url>
  <url><loc>https://surhires.com/integrations/zapier</loc></url>
</urlset>`;

export const BLOG_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://surhires.com/blog/remote-hiring-compliance-checklist-in-the-united-states</loc></url>
  <url><loc>https://surhires.com/blog/independent-contractor-compliance-guide-in-the-united-states</loc></url>
</urlset>`;

const ORG_GRAPH = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://surhires.com/#organization",
      name: "Surhires",
      legalName: "Soor LLC",
      url: "https://surhires.com",
      description: "Surhires is an AI-native recruitment software and applicant tracking system.",
      address: {
        "@type": "PostalAddress",
        streetAddress: "16192 Coastal Hwy",
        addressLocality: "Lewes",
        addressRegion: "DE",
        postalCode: "19958",
        addressCountry: "US",
      },
      contactPoint: [
        { "@type": "ContactPoint", telephone: "+1-607-318-2126", contactType: "sales", areaServed: ["US", "GB", "IN"] },
      ],
    },
    { "@type": "WebSite", "@id": "https://surhires.com/#website", url: "https://surhires.com" },
  ],
});

interface PageFixtureOptions {
  path: string;
  title: string;
  heading: string;
  description: string;
  body: string;
  faqs?: { q: string; a: string }[];
  outline?: string[];
  table?: boolean;
  pricing?: boolean;
  blogPosting?: boolean;
}

export function pageHtml(opts: PageFixtureOptions): string {
  const url = `https://surhires.com${opts.path}`;
  const webPage = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": opts.blogPosting ? "WebPage" : "WebPage",
        "@id": `${url}#webpage`,
        url,
        name: opts.heading,
        description: opts.description,
        inLanguage: "en-IN",
        datePublished: "2026-08-27",
        dateModified: "2026-09-08",
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://surhires.com/in" },
          { "@type": "ListItem", position: 2, name: opts.heading, item: url },
        ],
      },
    ],
  });

  const faqBlock = opts.faqs
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "ItemList",
        "@id": `${url}#questions`,
        itemListElement: opts.faqs.map((f, i) => ({
          "@type": "ListItem",
          position: i + 1,
          item: { "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } },
        })),
      })}</script>`
    : "";

  const pricingBlock = opts.pricing
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "@id": "https://surhires.com/in/#software",
        name: "Surhires",
        applicationCategory: "BusinessApplication",
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "INR",
          lowPrice: 2900,
          highPrice: 8000,
          offerCount: 3,
          offers: [
            {
              "@type": "Offer",
              name: "Starter",
              description: "For a small desk getting off spreadsheets.",
              price: 3500,
              priceCurrency: "INR",
              eligibleRegion: [{ "@type": "Country", name: "IN" }],
              priceSpecification: {
                "@type": "UnitPriceSpecification",
                price: 3500,
                priceCurrency: "INR",
                unitText: "per user per month, billed monthly",
              },
            },
            {
              "@type": "Offer",
              name: "Professional",
              price: 4500,
              priceCurrency: "INR",
              priceSpecification: { "@type": "UnitPriceSpecification", unitText: "per user per month, billed monthly" },
            },
            { "@type": "Offer", name: "Enterprise", price: 8000, priceCurrency: "INR" },
          ],
        },
      })}</script>`
    : "";

  const blogBlock = opts.blogPosting
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: opts.heading,
        datePublished: "2026-10-09T16:06:42.669+00:00",
        dateModified: "2026-10-09T16:06:42.836114+00:00",
        author: { "@type": "Organization", name: "The surhires.com team" },
      })}</script>`
    : "";

  const table = opts.table
    ? `<table><caption>Packaging &amp; price</caption><tr><th>Capability</th><th>Surhires</th><th>Them</th></tr><tr><td>AI matching</td><td>Professional</td><td>Top tier only</td></tr></table>`
    : "";

  return `<!DOCTYPE html><html lang="en"><head>
<title>${opts.title}</title>
<meta name="description" content="${opts.description}"/>
<link rel="canonical" href="${url}"/>
<script type="application/ld+json">${ORG_GRAPH}</script>
<script type="application/ld+json">${webPage}</script>
${faqBlock}${pricingBlock}${blogBlock}
</head><body>
<nav><a href="/in/features">Features</a><a href="/in/pricing">Pricing</a></nav>
<main>
<h1>${opts.heading}</h1>
${(opts.outline ?? ["How it works", "Where it does not help"]).map((h) => `<h2>${h}</h2>`).join("")}
<p>${opts.body}</p>
${table}
<a href="/in/features/resume-parsing">Resume parsing</a>
</main>
<footer><a href="/in/legal/terms">Terms</a></footer>
<script>window.__NEXT_DATA__={"should":"be stripped"}</script>
</body></html>`;
}

/** path (market-prefixed, as the client requests it) -> response body */
export const RESPONSES: Record<string, string> = {
  "/sitemap.xml": SITEMAP_INDEX,
  "/sitemaps/pages.xml": PAGES_SITEMAP,
  "/blog/sitemap.xml": BLOG_SITEMAP,

  "/in": pageHtml({
    path: "/in",
    title: "Recruitment software | Surhires",
    heading: "One workspace for candidates, jobs and clients",
    description: "Recruitment software and applicant tracking for staffing firms.",
    body: "A single workspace for the whole desk.",
    pricing: true,
  }),

  "/in/pricing": pageHtml({
    path: "/in/pricing",
    title: "Pricing | Surhires",
    heading: "Priced per seat, published in full, and provisional.",
    description: "Surhires pricing for recruitment teams in India: three plans per recruiter seat.",
    body: "Three plans, priced per recruiter seat per month, indirect tax excluded.",
    pricing: true,
    faqs: [{ q: "Is there a free tier?", a: "No. There is a 14-day trial and no free-forever tier." }],
  }),

  "/in/features/resume-parsing": pageHtml({
    path: "/in/features/resume-parsing",
    title: "AI resume parsing and enrichment | Surhires",
    heading: "Resumes become records, not attachments",
    description: "Turn a PDF, DOCX or scanned resume into a structured record with normalised skills.",
    body: "Extraction and structuring are two different problems. Optical character recognition handles scans.",
    outline: ["Extraction and structuring are two different problems", "Where parsing does not help"],
    faqs: [
      { q: "How accurate is it?", a: "Accuracy varies by format and we do not publish a single headline number." },
      { q: "Does it handle scanned resumes?", a: "Yes, through optical character recognition, at lower confidence." },
    ],
  }),

  "/in/features/interview-scheduling": pageHtml({
    path: "/in/features/interview-scheduling",
    title: "Interview scheduling | Surhires",
    heading: "Availability, self-booking and structured feedback",
    description: "Share availability, let candidates self-book, and collect structured interview feedback.",
    body: "Candidates self-book against real availability across time zones.",
  }),

  "/in/integrations/naukri": pageHtml({
    path: "/in/integrations/naukri",
    title: "Naukri integration | Surhires",
    heading: "Naukri posting and database search, built for Indian resume formats",
    description: "Database search and job posting for the India market, in build and gated on Naukri partner access.",
    body: "It is in build and gated on Naukri partner access. Downloading profiles and bulk importing them works today.",
    faqs: [
      {
        q: "Is the Naukri integration connected today?",
        a: "No. It is in build and gated on Naukri partner access, granted through an application process.",
      },
    ],
  }),

  "/in/integrations/slack": pageHtml({
    path: "/in/integrations/slack",
    title: "Slack integration | Surhires",
    heading: "Pipeline notifications in Slack",
    description: "Send stage changes and mentions to a Slack channel.",
    body: "Notifications land in the channel you choose.",
  }),

  "/in/integrations/zapier": pageHtml({
    path: "/in/integrations/zapier",
    title: "Zapier integration | Surhires",
    heading: "Zapier app, in development",
    description: "The Zapier app is in development for Wave 1 and not usable today.",
    body: "The app is in development for Wave 1 and not usable today. Developer documentation publishes when the app ships.",
    faqs: [{ q: "Can I use it now?", a: "No. It is in development for Wave 1 and there is no invite link yet." }],
  }),

  "/in/solutions/staffing-agencies": pageHtml({
    path: "/in/solutions/staffing-agencies",
    title: "ATS for staffing agencies | Surhires",
    heading: "Built for a billing desk",
    description: "Placement tracking, invoicing and margin for staffing agencies.",
    body: "Client, placement and margin tracking for agency desks.",
  }),

  "/in/vs/bullhorn": pageHtml({
    path: "/in/vs/bullhorn",
    title: "Surhires vs Bullhorn | Surhires",
    heading: "Recruitment software that is not gated behind the top tier",
    description: "How Surhires compares with Bullhorn on packaging, price and deployment.",
    body: "Where Bullhorn is still the right call: very large enterprise deployments.",
    table: true,
    faqs: [
      {
        q: "How current is this comparison?",
        a: "Bullhorn pricing was compiled from published vendor pricing pages on 27 August 2026 and has not been re-verified.",
      },
    ],
  }),

  "/in/mcp-server": pageHtml({
    path: "/in/mcp-server",
    title: "MCP server | Surhires",
    heading: "An agent interface to your desk, when the permissions are right",
    description: "The Surhires MCP server is planned, not shipping.",
    body: "The Surhires MCP server is planned, not shipping. No roadmap date is published here.",
    faqs: [{ q: "Can I use it today?", a: "No. It is planned and no roadmap date is published." }],
  }),

  "/in/whats-shipping": pageHtml({
    path: "/in/whats-shipping",
    title: "What is shipping | Surhires",
    heading: "What is in build, and what is not",
    description: "What is in build for Wave 1 and what has no build under way.",
    body: "The MCP server has no build under way. It waits on the permission model being right.",
  }),

  "/in/legal/dpdpa": pageHtml({
    path: "/in/legal/dpdpa",
    title: "India DPDPA | Surhires",
    heading: "India DPDPA",
    description: "How Surhires handles personal data under India's DPDP Act.",
    body: "Consent, retention and data principal rights under the DPDP Act.",
  }),

  "/in/blog/independent-contractor-compliance-guide-in-the-united-states": pageHtml({
    path: "/in/blog/independent-contractor-compliance-guide-in-the-united-states",
    title: "Independent Contractor Compliance Guide | Surhires",
    heading: "Independent Contractor Compliance Guide in the United States",
    description: "Independent contractor compliance means the right classification and contracts.",
    body: "Worker classification turns on control, and misclassification penalties are real.",
    blogPosting: true,
  }),

  "/in/blog/remote-hiring-compliance-checklist-in-the-united-states": pageHtml({
    path: "/in/blog/remote-hiring-compliance-checklist-in-the-united-states",
    title: "Remote Hiring Compliance Checklist | Surhires",
    heading: "Remote Hiring Compliance Checklist in the United States",
    description: "A checklist for hiring remote staff across state lines.",
    body: "State tax withholding follows where the employee works, not where you are.",
    blogPosting: true,
  }),
};
