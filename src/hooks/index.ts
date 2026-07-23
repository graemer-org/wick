import { collectUsage } from "../providers/types.js";
import { computeDelta } from "../attribution.js";
import { remapNotes, syncNotesToRemote, upsertNote } from "../notes.js";
import { loadState, saveState, withLock } from "../state.js";
import { repoRoot, tryGit } from "../git.js";

/**
 * Hook handlers. These are called from the installed git hooks via
 * `wick hook <event>`. They must NEVER fail the git operation — the CLI
 * wrapper catches everything and exits 0.
 */

/** Stamp `commit` with the token delta since the last stamp. */
export async function postCommit(cwd: string, commit?: string): Promise<void> {
  const root = repoRoot(cwd);
  const target = commit ?? tryGit(["rev-parse", "HEAD"], cwd);
  if (!target) return;

  await withLock(root, async () => {
    const state = await loadState(root);
    // Stamp against the moment BEFORE we read: any transcript write racing this
    // read carries an mtime past `stampTs`, so it is re-read next commit and no
    // delta is lost (see GetUsageOptions.since).
    const stampTs = new Date().toISOString();
    // Deltas are computed against CUMULATIVE session totals; `since` only lets
    // providers skip UNCHANGED transcripts (zero delta), it never bounds the
    // totals. A provider that throws here must not silently lose a PR's cost —
    // surface it as a stderr warning (the hook still exits 0 via the CLI wrapper).
    const { usage, discovered } = await collectUsage(root, {
      since: state.lastStampTs ?? undefined,
      onError: (providerId, err) =>
        console.error(
          `wick: warning: provider ${providerId} failed while collecting usage: ` +
            `${err instanceof Error ? err.message : err}`,
        ),
    });
    const { stamps, newState } = computeDelta(usage, state, stampTs, discovered);
    if (stamps.length > 0) {
      upsertNote(target, { v: 1, sessions: stamps }, root);
    }
    await saveState(root, newState);
  });
}

/**
 * Remap notes across a history rewrite (amend/rebase).
 * `pairs` are lines of "<old-sha> <new-sha>" as delivered on stdin.
 * Fixup/squash rebases map many old commits to one new commit, so pairs are
 * grouped by new commit and remapped together (see remapNotes for why).
 */
export async function postRewrite(cwd: string, pairs: string): Promise<void> {
  const root = repoRoot(cwd);
  const byNew = new Map<string, string[]>();
  for (const line of pairs.split("\n")) {
    const [oldSha, newSha] = line.trim().split(/\s+/);
    if (!oldSha || !newSha || oldSha === newSha) continue;
    byNew.set(newSha, [...(byNew.get(newSha) ?? []), oldSha]);
  }
  for (const [newSha, oldShas] of byNew) {
    try {
      remapNotes(oldShas, newSha, root);
    } catch {
      // never fail the git operation
    }
  }
}

/**
 * A merge creates a commit without firing post-commit, so treat it like one:
 * stamp the merge commit with the delta and refresh the baselines.
 */
export async function postMerge(cwd: string): Promise<void> {
  await postCommit(cwd);
}

/**
 * Ship the notes ref alongside every push, merging with the remote copy
 * when the refs diverged (CI's reconcile job pushes notes too).
 */
export async function prePush(cwd: string, remote: string): Promise<void> {
  if (!remote) return;
  const root = repoRoot(cwd);
  const result = syncNotesToRemote(remote, root);
  if (result === "failed") {
    console.error(
      `wick: warning: could not push refs/notes/wick to ${remote} — ` +
        `stamps stay local until the next push (manual: git push ${remote} refs/notes/wick)`,
    );
  }
}
