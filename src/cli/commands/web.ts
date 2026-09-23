/**
 * `memento web` — open the read-only workbench in a browser.
 *
 * The server half lives in `src/web/server.ts`; this file is only policy:
 * pick a port, announce what is being served, open a browser, wait for Ctrl+C.
 */
import { spawn } from "node:child_process";
import pc from "picocolors";
import { VERSION } from "../../version.ts";

export interface WebOptions {
  root: string;
  port?: number;
  /** Open a browser window (default true). */
  open?: boolean;
}

export async function webCmd(opts: WebOptions): Promise<number> {
  const { startWebServer } = await import("../../web/server.ts");

  let server;
  try {
    server = await startWebServer({ root: opts.root, port: opts.port });
  } catch (err) {
    process.stderr.write(pc.red(`\ncannot start the workbench: ${err instanceof Error ? err.message : String(err)}\n`));
    return 1;
  }

  process.stdout.write(
    `\n  ◈ memento workbench ${pc.dim(`v${VERSION}`)}\n\n` +
      `  url        ${pc.bold(server.url)}\n` +
      `  root       ${opts.root}\n` +
      `  scope      ${pc.dim("read-only · loopback-only · the UI never mutates the workspace")}\n` +
      `  live       ${pc.dim("open /#/live to watch a running session stream in")}\n\n` +
      `  ${pc.dim("Ctrl+C stops the server.")}\n`,
  );

  if (opts.open !== false) openBrowser(server.url);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.stdout.write(pc.dim("\nstopping workbench…\n"));
      void server.close().then(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

/** Best-effort: opening a browser must never break the server. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is printed above anyway */
  }
}
