import fs from "node:fs";

/**
 * Remove a temp directory, retrying on Windows handle-release races.
 *
 * A child process (tool shell, MCP transport) or a not-yet-collected file
 * handle can briefly pin a temp dir; on Windows an immediate rmSync then
 * fails with EPERM / EBUSY / ENOTEMPTY. Retry with a short sleep — the
 * handles always release. Non-race errors surface on the first attempt.
 */
export function rmWithRetry(target: string, tries = 5): void {
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1));
    }
  }
  fs.rmSync(target, { recursive: true, force: true }); // last try: surface the error
}
