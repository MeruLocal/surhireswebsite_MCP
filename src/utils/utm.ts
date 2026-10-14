/**
 * UTM tagging for links back to the Surhires site, so traffic an AI agent
 * sends there can be told apart in analytics.
 *
 * Only URLs on the configured origin's host are tagged; anything else is
 * returned untouched. Existing query parameters and the fragment are kept,
 * and a utm_* parameter the URL already carries is never overwritten.
 */
export const UTM_SOURCE = "mcp";
export const UTM_MEDIUM = "ai_agent";

export function withUtm(url: string | undefined, toolName: string, baseUrl: string): string | undefined {
  if (!url) return url;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return url;
  }
  if (parsed.host !== base.host) return url;

  const params: [string, string][] = [
    ["utm_source", UTM_SOURCE],
    ["utm_medium", UTM_MEDIUM],
    ["utm_campaign", toolName],
  ];
  for (const [key, value] of params) {
    if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}
