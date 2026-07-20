import { execFileSync } from "node:child_process";
import { mergeNoteVersions, mergeNotes, type NoteData } from "./attribution.js";

export const NOTES_REF = "refs/notes/wick";
const REMOTE_TMP_REF = "refs/notes/wick-sync-tmp";

function gitNotes(args: string[], cwd: string): string {
  return execFileSync("git", ["notes", `--ref=${NOTES_REF}`, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

export function readNote(commit: string, cwd: string): NoteData | null {
  let raw: string;
  try {
    raw = gitNotes(["show", commit], cwd);
  } catch {
    return null; // no note on this commit
  }
  try {
    const data = JSON.parse(raw);
    if (data && data.v === 1 && Array.isArray(data.sessions)) return data;
  } catch {
    // malformed note — treat as absent
  }
  return null;
}

export function writeNote(commit: string, data: NoteData, cwd: string): void {
  gitNotes(["add", "-f", "-m", JSON.stringify(data), commit], cwd);
}

/** Merge `data` into whatever note already exists on `commit`. */
export function upsertNote(commit: string, data: NoteData, cwd: string): void {
  const existing = readNote(commit, cwd);
  writeNote(commit, existing ? mergeNotes(existing, data) : data, cwd);
}

function tryRun(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Push the notes ref, merging with the remote's copy first when the refs
 * have diverged (CI's reconcile job also pushes notes commits, so a plain
 * push gets a non-fast-forward rejection and local stamps silently never
 * reach origin — that exact failure lost a PR's cost once).
 */
export function syncNotesToRemote(
  remote: string,
  cwd: string,
): "pushed" | "merged-and-pushed" | "failed" {
  const push = () =>
    tryRun(["push", "--no-verify", remote, `${NOTES_REF}:${NOTES_REF}`], cwd) !== null;
  if (push()) return "pushed";

  if (tryRun(["fetch", remote, `+${NOTES_REF}:${REMOTE_TMP_REF}`], cwd) === null) {
    return "failed";
  }
  const remoteSha = tryRun(["rev-parse", REMOTE_TMP_REF], cwd);
  try {
    // Per-annotated-commit merge with our own semantics; git's built-in
    // notes-merge strategies either drop one side or corrupt the JSON.
    const listing = tryRun(["notes", `--ref=${REMOTE_TMP_REF}`, "list"], cwd) ?? "";
    for (const line of listing.split("\n")) {
      const [noteSha, commitSha] = line.trim().split(/\s+/);
      if (!noteSha || !commitSha) continue;
      const raw = tryRun(["cat-file", "-p", noteSha], cwd);
      if (!raw) continue;
      let remoteNote: NoteData;
      try {
        remoteNote = JSON.parse(raw);
        if (!remoteNote || remoteNote.v !== 1 || !Array.isArray(remoteNote.sessions)) continue;
      } catch {
        continue; // malformed remote note — leave local as-is
      }
      const localNote = readNote(commitSha, cwd);
      if (!localNote) {
        writeNote(commitSha, remoteNote, cwd);
      } else if (JSON.stringify(localNote) !== JSON.stringify(remoteNote)) {
        writeNote(commitSha, mergeNoteVersions(localNote, remoteNote), cwd);
      }
    }
  } finally {
    tryRun(["update-ref", "-d", REMOTE_TMP_REF], cwd);
  }
  // The note contents are merged but the ref histories are still divergent,
  // so a plain push stays non-fast-forward. Force with a lease pinned to the
  // exact remote sha we merged from — if the remote moved meanwhile, fail
  // safely and let the next push retry.
  if (!remoteSha) return "failed";
  const forced =
    tryRun(
      [
        "push",
        "--no-verify",
        `--force-with-lease=${NOTES_REF}:${remoteSha}`,
        remote,
        `${NOTES_REF}:${NOTES_REF}`,
      ],
      cwd,
    ) !== null;
  return forced ? "merged-and-pushed" : "failed";
}

/**
 * Copy/merge notes from all old commits that were rewritten into one new
 * commit (post-rewrite remapping). Fixup/squash rebases map MANY old commits
 * to ONE new commit, and git's own notes.rewriteRef copying has already run
 * by the time the hook fires — so the pairs must be handled as a group
 * against a single up-front read of the target, not one at a time:
 * pair-at-a-time merging against a mutating target can't tell "note git
 * copied from source F" apart from "F already merged" and double-counts F
 * when notes.rewriteMode=overwrite.
 */
export function remapNotes(oldCommits: string[], newCommit: string, cwd: string): void {
  const oldNotes = oldCommits
    .map((c) => readNote(c, cwd))
    .filter((n): n is NoteData => n !== null);
  if (oldNotes.length === 0) return;

  // A pre-existing target note identical to any source is git's own
  // rewriteRef copy (rewriteMode=overwrite copies one source verbatim;
  // the default concatenate produces malformed JSON that readNote already
  // treats as absent) — drop it, the merge re-adds that stamp exactly once.
  // A fresh post-commit stamp from an amend differs from every source and
  // is kept as the merge base.
  let base = readNote(newCommit, cwd);
  if (base !== null) {
    const b = JSON.stringify(base);
    if (oldNotes.some((o) => JSON.stringify(o) === b)) base = null;
  }

  const merged = oldNotes.reduce(
    (acc, o) => mergeNotes(acc, o),
    base ?? { v: 1 as const, sessions: [] },
  );
  const current = readNote(newCommit, cwd);
  if (current && JSON.stringify(current) === JSON.stringify(merged)) return;
  writeNote(newCommit, merged, cwd);
}
