import { execFileSync } from "node:child_process";
import { mergeNotes, type NoteData } from "./attribution.js";
import { readAllNotes, remapNotes, writeNote } from "./notes.js";
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
  // One batched read of the whole ref instead of a `git notes show` per source
  // commit — the reconcile job runs over a squash/rebase PR's full range (#39).
  const notes = readAllNotes(cwd);
  if (notes.has(onto)) return "target-already-stamped";
  let merged: NoteData | null = null;
  for (const sha of sourceShas) {
    const note = notes.get(sha);
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

/**
 * The shape a server-side PR merge took, as far as the stamps care:
 *  - `merge-commit` — a real (>1 parent) merge; the PR's commits stay reachable
 *    on the base branch, so their notes need no remap.
 *  - `squash` — one brand-new commit carries the PR's whole diff; union the
 *    PR commits' notes onto it.
 *  - `rebase` — each PR commit was replayed 1:1 onto the base tip; remap each
 *    old→new pair.
 *  - `unrecognized` — none of the above matched; skip rather than mis-stamp.
 */
export type MergeShape =
  | { kind: "merge-commit" }
  | { kind: "squash"; onto: string; sources: string[] }
  | { kind: "rebase"; pairs: Array<[string, string]> }
  | { kind: "unrecognized" };

/** patch-id of a raw `git diff <args>` (null for an empty diff). */
function diffPatchId(cwd: string, diffArgs: string[]): string | null {
  const diff = tryGit(["diff", ...diffArgs], cwd);
  if (!diff) return null;
  try {
    // --stable zeroes the hunk line numbers, so a commit's patch-id survives
    // being replayed onto a drifted base (different line offsets, same change).
    // This is precisely git's own "already applied?" signal for rebases.
    const out = execFileSync("git", ["patch-id", "--stable"], {
      cwd,
      input: diff,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    const id = out.split(/\s+/)[0];
    return id || null;
  } catch {
    return null;
  }
}

/** True when both commits introduce the same change (drift-tolerant). */
function samePatch(cwd: string, a: string, b: string): boolean {
  const idA = diffPatchId(cwd, [`${a}^`, a]);
  const idB = diffPatchId(cwd, [`${b}^`, b]);
  return idA !== null && idA === idB;
}

/**
 * Classify how a merged PR landed on the base branch, so the reconcile job can
 * remap the PR's stamps onto whatever commit(s) the merge produced.
 *
 * The hard part is drift: the base branch routinely gains unrelated commits
 * while a PR sits open (and PRs often merge the base into themselves), so the
 * old detector — which COUNTED commits in `merge-base(base, prHead)..mergeSha`
 * — miscounted the moment any of that drift landed between the fork point and
 * the merge, and skipped every affected PR (#47). This compares by patch-id
 * off the merge commit's OWN first-parent chain instead, which is immune to
 * what the base branch did elsewhere.
 */
export function detectMergeShape(
  cwd: string,
  params: { baseRef: string; prHead: string; mergeSha: string },
): MergeShape {
  const { baseRef, prHead, mergeSha } = params;

  // A real merge commit keeps the PR's commits reachable — nothing to remap.
  const parents = tryGit(["rev-list", "--parents", "-n", "1", mergeSha], cwd);
  const nParents = parents ? parents.split(/\s+/).length - 1 : 0;
  if (nParents > 1) return { kind: "merge-commit" };

  const base = tryGit(["merge-base", baseRef, prHead], cwd);
  if (!base) return { kind: "unrecognized" };
  const prShas = rangeShas(cwd, `${base}..${prHead}`);
  if (prShas.length === 0) return { kind: "unrecognized" };

  // Rebase merge: the top N first-parent commits ending at mergeSha are the PR
  // commits replayed in order. Confirm by patch-id — a raw count of that range
  // would fold in any base-branch drift below the replayed commits.
  const walk = tryGit(
    ["rev-list", "--first-parent", "--reverse", "-n", String(prShas.length), mergeSha],
    cwd,
  );
  const mainShas = walk ? walk.split("\n").filter(Boolean) : [];
  if (
    mainShas.length === prShas.length &&
    prShas.every((sha, i) => samePatch(cwd, sha, mainShas[i]))
  ) {
    return {
      kind: "rebase",
      pairs: prShas.map((sha, i): [string, string] => [sha, mainShas[i]]),
    };
  }

  // Squash merge: one commit carries the PR's whole net diff. Compare the
  // squash commit's own first-parent diff against the PR's net diff by
  // patch-id — equal even when the base drifted under the squash.
  const prNet = diffPatchId(cwd, [base, prHead]);
  const squashNet = diffPatchId(cwd, [`${mergeSha}^`, mergeSha]);
  if (prNet !== null && prNet === squashNet) {
    return { kind: "squash", onto: mergeSha, sources: prShas };
  }

  return { kind: "unrecognized" };
}

export interface ReconcileMergeResult {
  shape: MergeShape;
  /** True when a note was actually (re)written — gates the notes push. */
  wrote: boolean;
  /** Human-readable summary of what happened, for the CLI/CI log. */
  note: string;
}

/**
 * Detect a merged PR's shape and remap its stamps accordingly. The caller
 * (the `wick reconcile-merge` CLI, run by CI's reconcile job) pushes the notes
 * ref only when `wrote` is true — a squash/rebase whose commits carried no
 * stamps must not trigger a pointless force-with-lease round-trip.
 */
export function reconcileMerge(
  cwd: string,
  params: { baseRef: string; prHead: string; mergeSha: string },
): ReconcileMergeResult {
  const shape = detectMergeShape(cwd, params);
  switch (shape.kind) {
    case "merge-commit":
      return { shape, wrote: false, note: "merge commit — stamps already reachable, nothing to reconcile" };
    case "squash": {
      const result = consolidateNotes(cwd, shape.sources, shape.onto);
      const note =
        result === "written"
          ? `squash merge — consolidated ${shape.sources.length} commit(s) onto ${shape.onto}`
          : result === "target-already-stamped"
            ? `squash merge — ${shape.onto} already stamped, nothing to do`
            : "squash merge — no stamps on the PR's commits, nothing to do";
      return { shape, wrote: result === "written", note };
    }
    case "rebase": {
      let wrote = false;
      for (const [oldSha, newSha] of shape.pairs) {
        if (remapNotes([oldSha], newSha, cwd)) wrote = true;
      }
      return { shape, wrote, note: `rebase merge — remapped ${shape.pairs.length} commit(s)` };
    }
    case "unrecognized":
      return { shape, wrote: false, note: "unrecognized merge shape — skipping" };
  }
}
