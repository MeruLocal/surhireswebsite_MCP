/** Spawns the built HTTP entry point on a free local port for black-box tests. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

export interface RunningServer {
  base: string;
  port: number;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? ok(addr.port) : fail(new Error("no port"))));
    });
  });
}

export async function startHttp(env: Record<string, string> = {}): Promise<RunningServer> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [resolve(import.meta.dirname, "../dist/http.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      MCP_HTTP_HOST: "127.0.0.1",
      // Nothing in these tests should reach a real origin.
      SURHIRES_BASE_URL: "http://127.0.0.1:9",
      SURHIRES_MAX_RETRIES: "0",
      LOG_LEVEL: "info",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("server did not start")), 10_000);
    let buf = "";
    child.stderr!.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("listening on http")) {
        clearTimeout(timer);
        ok();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`server exited early (${code}): ${buf}`));
    });
  });

  return {
    base: `http://127.0.0.1:${port}`,
    port,
    stop: () =>
      new Promise((ok) => {
        child.removeAllListeners("exit");
        child.once("exit", () => ok());
        child.kill("SIGTERM");
      }),
  };
}

export const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

export const toolsList = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
