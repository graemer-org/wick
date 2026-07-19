import { mergeNotes, type NoteData } from "./attribution.js";
import { readNote, writeNote } from "./notes.js";
import { tryGit } from "./git.js";

/**
 * Squash-merge (and cherry-pick/reset) reconciliation.
 *
 * A squash merge — locally via `git merge --squash`, or server-side via the
 * GitHub "Squash and merge" button — creates a brand-new commit that no
 * post-rewrite hook ever maps, so the stamps stay behind on the source
 * commits. consolidateNotes() copies the merged union of the source commits'
 * notes onto the new commit.
 *
 * Idempotency: if the target already carries a wick note, nothing is written —
 * a squash commit is freshly minted, so an existing note means reconciliation
 * (or a hook stamp) already happened and merging again would double-count.
 */

export type ReconcileResult = "written" | "target-already-stamped" | "no-source-notes";

export function consolidateNotes(
  cwd: string,
  sourceShas: string[],
  onto: string,
): ReconcileResult {
  if (readNote(onto, cwd)) return "target-already-stamped";
  let merged: NoteData | null = null;
  for (const sha of sourceShas) {
    const note = readNote(sha, cwd);
    if (note) merged = merged ? mergeNotes(merged, note) : note;
  }
  if (!merged) return "no-source-notes";
  writeNote(onto, merged, cwd);
  return "written";
}

/** Oldest-first commit shas for a revision range like "base..head". */
export function rangeShas(cwd: string, range: string): string[] {
  const out = tryGit(["rev-list", "--reverse", range], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}
