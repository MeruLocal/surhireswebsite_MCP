import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./utils/logger.js";
import { SurhiresClient, type FetchLike } from "./clients/surhires-client.js";
import { registerPageTools } from "./tools/pages.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerPricingTools } from "./tools/pricing.js";
import { registerContentTools } from "./tools/content.js";
import { registerCompanyTools } from "./tools/company.js";
import type { ToolContext } from "./tools/shared.js";

export const SERVER_NAME = "surhires-mcp";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `This server reads Surhires' public website (surhires.com) -- a recruitment ATS/CRM vendor.

Scope, stated plainly so you do not over-promise to the user:

  * It reads published marketing, product, pricing, comparison and blog pages.
  * It holds NO credentials and reaches NO authenticated system.
  * It CANNOT search candidates, post or edit jobs, submit applications, read a
    pipeline, or touch any ATS record. Surhires publishes no API, no API keys and
    no developer documentation, and its own site describes its MCP server as
    planned with no build under way. Call get_api_and_mcp_status for the live
    wording before telling a user otherwise.

Useful starting points: list_site_pages to see everything published,
search_site for a keyword, get_pricing for plans, list_features and
list_integrations for the catalogue, get_integration_status to check whether a
named connector actually works yet, and get_roadmap for what is shipping.

Two cautions when summarising results. Pages describing a capability do not
prove it ships -- several say in their own FAQ that they are in build or gated on
partner access. And the /vs pages are vendor-authored comparisons, so present
them as Surhires' claims rather than neutral findings.`;

export interface BuildOptions {
  config?: Config;
  logger?: Logger;
  fetchImpl?: FetchLike;
  /**
   * A client to share across server instances. The HTTP transport builds one
   * server per request; passing one long-lived client keeps its page cache,
   * request coalescing and outbound concurrency limit working across requests.
   */
  client?: SurhiresClient;
  /** Per-call page budget for fan-out tools (set by the HTTP transport). */
  deepPageCap?: number;
}

export function buildServer(options: BuildOptions = {}): {
  server: McpServer;
  config: Config;
  log: Logger;
  client: SurhiresClient;
  toolNames: string[];
} {
  const config = options.config ?? loadConfig();
  const log = options.logger ?? createLogger(config);
  const client = options.client ?? new SurhiresClient(config, log, options.fetchImpl);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );

  const ctx: ToolContext = { client, defaultMarket: config.market, deepPageCap: options.deepPageCap };

  // Record tool names as they register, so callers (and the HTTP status page)
  // can report them without reaching into the SDK's internals.
  const toolNames: string[] = [];
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    toolNames.push(name);
    return (register as (...args: unknown[]) => unknown)(name, ...rest);
  }) as typeof server.registerTool;

  registerPageTools(server, ctx, config.baseUrl);
  registerCatalogTools(server, ctx);
  registerPricingTools(server, ctx);
  registerContentTools(server, ctx);
  registerCompanyTools(server, ctx);

  log.info("server built", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    base_url: config.baseUrl,
    market: config.market,
  });

  return { server, config, log, client, toolNames: [...toolNames].sort() };
}
