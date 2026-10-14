/**
 * HTML -> structured content extraction.
 *
 * Every shape here was verified against live surhires.com pages (2026-10-13).
 * The site is a Next.js app that embeds schema.org JSON-LD on every page:
 *
 *   - an Organization + WebSite graph (identical site-wide)
 *   - a WebPage or CollectionPage node: name, description, datePublished,
 *     dateModified, inLanguage, breadcrumb
 *   - on home/pricing, a SoftwareApplication node whose offers is an
 *     AggregateOffer containing one Offer per plan
 *   - an ItemList of Question/Answer pairs (the page's FAQ block)
 *
 * JSON-LD is preferred wherever present; headings and body text are recovered
 * from the markup only for the prose the JSON-LD does not carry.
 */

export interface JsonLdNode {
  "@type"?: string | string[];
  [key: string]: unknown;
}

export interface Faq {
  question: string;
  answer: string;
}

export interface Plan {
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  unit?: string;
  eligible_regions?: string[];
}

export interface Pricing {
  currency?: string;
  low_price?: number;
  high_price?: number;
  plan_count?: number;
  plans: Plan[];
}

export interface Breadcrumb {
  position: number;
  name: string;
  path?: string;
}

export interface ExtractedPage {
  path: string;
  url?: string;
  canonical_url?: string;
  title?: string;
  heading?: string;
  description?: string;
  language?: string;
  date_published?: string;
  date_modified?: string;
  page_type?: string;
  breadcrumbs: Breadcrumb[];
  outline: { level: 2 | 3; text: string }[];
  body_text: string;
  faqs: Faq[];
  pricing?: Pricing;
  internal_links: { path: string; text: string }[];
  tables: { caption?: string; headers: string[]; rows: string[][] }[];
}

const typeOf = (node: JsonLdNode): string[] => {
  const t = node["@type"];
  return Array.isArray(t) ? t : typeof t === "string" ? [t] : [];
};

const isType = (node: JsonLdNode, ...wanted: string[]): boolean =>
  typeOf(node).some((t) => wanted.includes(t));

/** Collects every JSON-LD node on the page, flattening @graph containers. */
export function extractJsonLd(html: string): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    const raw = block[1];
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue; // A malformed block must not fail the whole page.
    }
    const queue: unknown[] = [parsed];
    while (queue.length > 0) {
      const item = queue.pop();
      if (Array.isArray(item)) {
        queue.push(...item);
      } else if (item && typeof item === "object") {
        const node = item as JsonLdNode;
        if (Array.isArray(node["@graph"])) queue.push(...(node["@graph"] as unknown[]));
        if (node["@type"]) nodes.push(node);
      }
    }
  }
  return nodes;
}

export function findNode(nodes: JsonLdNode[], ...wanted: string[]): JsonLdNode | undefined {
  return nodes.find((n) => isType(n, ...wanted));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  eacute: "é",
  pound: "£",
  euro: "€",
  deg: "°",
};

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (/^#x/i.test(code)) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });

/** Strips tags from an HTML fragment and collapses whitespace. */
export function textOf(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const attr = (html: string, re: RegExp): string | undefined => html.match(re)?.[1];

function extractOutline(html: string): { level: 2 | 3; text: string }[] {
  const out: { level: 2 | 3; text: string }[] = [];
  for (const m of html.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = textOf(m[2] ?? "");
    if (text && text.length < 300) out.push({ level: Number(m[1]) as 2 | 3, text });
  }
  return out;
}

function extractBody(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  // Drop the chrome that repeats on every page so body_text stays about the page.
  const stripped = main
    .replace(/<(nav|header|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  return textOf(stripped);
}

function extractInternalLinks(html: string): { path: string; text: string }[] {
  const seen = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["'](\/[^"'#?]*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const path = (m[1] ?? "").replace(/(.)\/$/, "$1");
    const text = textOf(m[2] ?? "");
    if (!path || path.startsWith("/_next") || !text) continue;
    if (!seen.has(path)) seen.set(path, text.slice(0, 120));
  }
  return [...seen].map(([path, text]) => ({ path, text }));
}

function extractTables(html: string): ExtractedPage["tables"] {
  const tables: ExtractedPage["tables"] = [];
  for (const t of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const inner = t[1] ?? "";
    const caption =
      textOf(inner.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] ?? "") || undefined;
    const headers: string[] = [];
    const rows: string[][] = [];
    for (const r of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const rowHtml = r[1] ?? "";
      const ths = [...rowHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((c) => textOf(c[1] ?? ""));
      const tds = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => textOf(c[1] ?? ""));
      if (ths.length > 0 && headers.length === 0 && tds.length === 0) headers.push(...ths);
      else if (tds.length > 0) rows.push([...ths, ...tds]);
    }
    if (headers.length > 0 || rows.length > 0) tables.push({ caption, headers, rows });
  }
  return tables;
}

/** Pulls Question/Answer pairs out of the page's ItemList node. */
export function extractFaqs(nodes: JsonLdNode[]): Faq[] {
  const faqs: Faq[] = [];
  for (const node of nodes) {
    if (!isType(node, "ItemList", "FAQPage")) continue;
    const list = (node.itemListElement ?? node.mainEntity) as unknown;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const holder = entry as JsonLdNode;
      const question = isType(holder, "Question")
        ? holder
        : (holder.item as JsonLdNode | undefined);
      if (!question || !isType(question, "Question")) continue;
      const name = typeof question.name === "string" ? question.name : undefined;
      const accepted = question.acceptedAnswer as JsonLdNode | undefined;
      const answer = accepted && typeof accepted.text === "string" ? accepted.text : undefined;
      if (name && answer) faqs.push({ question: name, answer });
    }
  }
  return faqs;
}

/** Reads the AggregateOffer/Offer tree off a SoftwareApplication node. */
export function extractPricing(nodes: JsonLdNode[]): Pricing | undefined {
  const app = findNode(nodes, "SoftwareApplication", "Product");
  const aggregate = app?.offers as JsonLdNode | undefined;
  if (!aggregate || typeof aggregate !== "object") return undefined;

  const num = (v: unknown): number | undefined => {
    if (typeof v === "number") return v;
    const parsed = Number(v);
    return Number.isFinite(parsed) && v !== null && v !== "" ? parsed : undefined;
  };

  const offers = Array.isArray(aggregate.offers) ? (aggregate.offers as JsonLdNode[]) : [];
  const plans: Plan[] = offers.map((offer) => {
    const spec = offer.priceSpecification as JsonLdNode | undefined;
    const regions = Array.isArray(offer.eligibleRegion)
      ? (offer.eligibleRegion as JsonLdNode[]).map((r) => String(r.name ?? "")).filter(Boolean)
      : undefined;
    return {
      name: String(offer.name ?? "unnamed plan"),
      description: typeof offer.description === "string" ? offer.description : undefined,
      price: num(offer.price),
      currency: typeof offer.priceCurrency === "string" ? offer.priceCurrency : undefined,
      unit: spec && typeof spec.unitText === "string" ? spec.unitText : undefined,
      eligible_regions: regions && regions.length > 0 ? regions : undefined,
    };
  });

  return {
    currency: typeof aggregate.priceCurrency === "string" ? aggregate.priceCurrency : undefined,
    low_price: num(aggregate.lowPrice),
    high_price: num(aggregate.highPrice),
    plan_count: num(aggregate.offerCount),
    plans,
  };
}

function extractBreadcrumbs(nodes: JsonLdNode[]): Breadcrumb[] {
  const list = findNode(nodes, "BreadcrumbList");
  if (!list || !Array.isArray(list.itemListElement)) return [];
  return (list.itemListElement as JsonLdNode[])
    .map((entry) => {
      const item = entry.item;
      let path: string | undefined;
      if (typeof item === "string") {
        try {
          path = new URL(item).pathname;
        } catch {
          path = undefined;
        }
      }
      return { position: Number(entry.position) || 0, name: String(entry.name ?? ""), path };
    })
    .filter((b) => b.name !== "")
    .sort((a, b) => a.position - b.position);
}

export function extractPage(path: string, html: string): ExtractedPage {
  const nodes = extractJsonLd(html);
  const page = findNode(nodes, "WebPage", "CollectionPage", "Article", "BlogPosting", "ItemPage");

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;
  const canonical = attr(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  const metaDescription = attr(
    html,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  );

  return {
    path,
    url: str(page?.url) ?? canonical,
    canonical_url: canonical,
    title: textOf(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || undefined,
    heading: textOf(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") || str(page?.name),
    description:
      str(page?.description) ?? (metaDescription ? decodeEntities(metaDescription) : undefined),
    language: str(page?.inLanguage),
    date_published: str(page?.datePublished),
    date_modified: str(page?.dateModified),
    page_type: page ? typeOf(page)[0] : undefined,
    breadcrumbs: extractBreadcrumbs(nodes),
    outline: extractOutline(html),
    body_text: extractBody(html),
    faqs: extractFaqs(nodes),
    pricing: extractPricing(nodes),
    internal_links: extractInternalLinks(html),
    tables: extractTables(html),
  };
}

/** The site-wide Organization node: legal name, address, contact points. */
export function extractOrganization(html: string): JsonLdNode | undefined {
  return findNode(extractJsonLd(html), "Organization");
}
