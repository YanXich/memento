/**
 * `memento undo` — restore the state before the most recent tool write.
 *
 * The file tools record a snapshot before every write (`.memento/undo/`),
 * so an undo restores exactly the previous step — including the session that
 * created it, since snapshots live on disk. This is the safety net that makes
 * "let the agent try" a reversible decision.
 */
import pc from "picocolors";
import { hasUndoSnapshots, undoLatest } from "../../tools/snapshot.ts";

export function undoCmd(root: string): number {
  const result = undoLatest(root);
  if ("error" in result) {
    process.stderr.write(pc.yellow(result.error + "\n"));
    return 1;
  }
  const restored = result.restored;
  const removed = result.removed;
  if (restored.length === 0 && removed.length === 0) {
    process.stdout.write(pc.dim("nothing to undo\n"));
    return 0;
  }
  for (const rel of restored) process.stdout.write(`${pc.green("restored")} ${rel}\n`);
  for (const rel of removed) process.stdout.write(`${pc.red("removed")} ${rel}\n`);
  process.stdout.write(pc.dim(`run again to undo the step before that${hasUndoSnapshots(root) ? "" : " (this was the last one)"}\n`));
  return 0;
}
