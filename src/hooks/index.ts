import { collectUsage } from "../providers/types.js";
import { computeDelta } from "../attribution.js";
import { remapNote, upsertNote } from "../notes.js";
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
    // Deltas are computed against CUMULATIVE session totals — do not pass a
    // time window here, or windowed totals get compared against cumulative
    // baselines and every delta collapses to zero.
    const usage = await collectUsage(root, {});
    const { stamps, newState } = computeDelta(usage, state);
    if (stamps.length > 0) {
      upsertNote(target, { v: 1, sessions: stamps }, root);
    }
    await saveState(root, newState);
  });
}

/**
 * Remap notes across a history rewrite (amend/rebase).
 * `pairs` are lines of "<old-sha> <new-sha>" as delivered on stdin.
 */
export async function postRewrite(cwd: string, pairs: string): Promise<void> {
  const root = repoRoot(cwd);
  for (const line of pairs.split("\n")) {
    const [oldSha, newSha] = line.trim().split(/\s+/);
    if (!oldSha || !newSha || oldSha === newSha) continue;
    try {
      remapNote(oldSha, newSha, root);
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
