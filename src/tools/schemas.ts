import { z } from "zod";

/**
 * Output schemas for the tools that return structured data. Objects are loose
 * (extra keys allowed) and every extracted field is optional, because a page
 * can omit any of them: a strict client rejects a result that does not match,
 * so the contract promises only what is always present.
 */
const loose = z.looseObject;

export const FaqOutput = loose({ question: z.string(), answer: z.string() });

export const PlanOutput = loose({
  name: z.string(),
  price: z.number().optional(),
  currency: z.string().optional(),
  unit: z.string().optional(),
  description: z.string().optional(),
});

/** A caveat is either a static sentence or a sentence quoted from a named source. */
export const CaveatOutput = z.union([z.string(), loose({ text: z.string(), source: z.string().optional() })]);

export const PricingOutput = loose({
  market: z.string(),
  path: z.string(),
  url: z.string().optional(),
  currency: z.string().optional(),
  price_range: loose({ low: z.number().optional(), high: z.number().optional() }),
  plan_count: z.number(),
  plans: z.array(PlanOutput),
  faqs: z.array(FaqOutput),
  caveats: z.array(CaveatOutput),
  date_modified: z.string().optional(),
});

export const MarketPricingOutput = z.union([
  loose({ market: z.string(), path: z.string(), currency: z.string().optional(), plans: z.array(PlanOutput) }),
  loose({ market: z.string(), error: z.string() }),
]);

export const ComparePricingOutput = loose({
  by_market: z.array(MarketPricingOutput),
  note: z.string().optional(),
});

/** The payload of presentPage(): the fields every page-reading tool returns. */
export const PageOutput = loose({
  path: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  heading: z.string().optional(),
  description: z.string().optional(),
  date_modified: z.string().optional(),
  body_text: z.string(),
  body_truncated: z.boolean(),
  faqs: z.array(FaqOutput).optional(),
});

export const CompetitorOutput = PageOutput.extend({ competitor: z.string(), bias_note: z.string() });

/** One row of any list tool: always a path, usually a slug. */
export const ListItemOutput = loose({ path: z.string(), slug: z.string().optional() });

/** The shape of every list tool's result (paged lists carry the paging fields). */
export const ListOutput = loose({
  total: z.number(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  returned: z.number().optional(),
  has_more: z.boolean().optional(),
  results: z.array(ListItemOutput),
  note: z.string().optional(),
});
