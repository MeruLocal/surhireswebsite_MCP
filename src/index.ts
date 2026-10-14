#!/usr/bin/env node
/**
 * stdio entry point -- this is what Claude Desktop launches.
 *
 * Nothing may be written to stdout except MCP protocol frames, so every log
 * line goes to stderr (see utils/logger.ts).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const { server, log } = buildServer();
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  log.info("listening on stdio");
}

main().catch((error: unknown) => {
  // A startup failure must be legible in the Claude Desktop MCP log.
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "fatal startup failure",
      detail: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
