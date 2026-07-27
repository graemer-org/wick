import { execFileSync } from "node:child_process";
import { mergeNoteVersions, mergeNotes, type NoteData } from "./attribution.js";

export const NOTES_REF = "refs/notes/wick";
const REMOTE_TMP_REF = "refs/notes/wick-sync-tmp";
const REMOTE_FETCH_TMP_REF = "refs/notes/wick-fetch-tmp";

function gitNotes(args: string[], cwd: string): string {
  return execFileSync("git", ["notes", `--ref=${NOTES_REF}`, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/** Parse a raw note blob, returning null for malformed JSON (treated as absent). */
function parseNote(raw: string): NoteData | null {
  try {
    const data = JSON.parse(raw);
    if (data && data.v === 1 && Array.isArray(data.sessions)) return data;
  } catch {
    // malformed note — treat as absent
  }
  return null;
}

export function readNote(commit: string, cwd: string): NoteData | null {
  let raw: string;
  try {
    raw = gitNotes(["show", commit], cwd);
  } catch {
    return null; // no note on this commit
  }
  return parseNote(raw);
}

/**
 * Resolve many git object shas to their contents in ONE `git cat-file --batch`
 * (shas on stdin, `<sha> <type> <size>\n<payload>\n` per object on stdout, or
 * `<sha> missing\n` with no payload). Parsed off a Buffer, not a decoded
 * string: a note payload can contain newlines, so the record boundary is the
 * declared byte size, not a line break. Returns echoed-sha → payload.
 */
function batchCatBlobs(shas: string[], cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  if (shas.length === 0) return out;
  let stdout: Buffer;
  try {
    stdout = execFileSync("git", ["cat-file", "--batch"], {
      cwd,
      input: shas.join("\n") + "\n",
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return out;
  }
  let pos = 0;
  while (pos < stdout.length) {
    const nl = stdout.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = stdout.toString("utf8", pos, nl);
    pos = nl + 1;
    const [sha, , sizeStr] = header.split(" ");
    // "<sha> missing" (or any header without a size) → no payload follows.
    const size = Number(sizeStr);
    if (!sizeStr || !Number.isInteger(size)) continue;
    out.set(sha, stdout.toString("utf8", pos, pos + size));
    pos += size + 1; // payload + its trailing newline
  }
  return out;
}

/**
 * Read every note on `ref` in a constant number of git spawns, regardless of
 * how many commits are annotated. `readNote`-in-a-loop shells out one
 * `git notes show` per commit — on a full-history report/badge that is one
 * spawn per commit in the whole repo to read a handful of actual notes (#39).
 * This collapses it to two spawns: `git notes list` for the
 * `<noteBlobSha> <commitSha>` pairs, then one `git cat-file --batch` over the
 * note blobs. Malformed notes are skipped, exactly as `readNote` treats them.
 * Returns commitSha → NoteData for every commit carrying a valid note.
 */
export function readAllNotes(cwd: string, ref: string = NOTES_REF): Map<string, NoteData> {
  const notes = new Map<string, NoteData>();
  const listing = tryRun(["notes", `--ref=${ref}`, "list"], cwd);
  if (!listing) return notes; // ref missing or no notes on it

  const pairs: Array<[noteSha: string, commitSha: string]> = [];
  for (const line of listing.split("\n")) {
    const [noteSha, commitSha] = line.trim().split(/\s+/);
    if (noteSha && commitSha) pairs.push([noteSha, commitSha]);
  }

  const blobs = batchCatBlobs(
    pairs.map(([noteSha]) => noteSha),
    cwd,
  );
  for (const [noteSha, commitSha] of pairs) {
    const raw = blobs.get(noteSha);
    if (raw === undefined) continue;
    const data = parseNote(raw);
    if (data) notes.set(commitSha, data);
  }
  return notes;
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
 * Merge every note on `sourceRef` into the local NOTES_REF, per annotated
 * commit: adopt the source note where local has none, otherwise merge with
 * mergeNoteVersions (per-class max, so a stale copy never lowers or doubles a
 * local stamp). Used in both sync directions. git's built-in notes-merge
 * strategies either drop one side or corrupt the JSON, so we do it ourselves.
 */
function mergeRefIntoLocalNotes(sourceRef: string, cwd: string): void {
  // Load both refs in a constant number of spawns (two each) instead of
  // 2-3 per source note; only the notes that actually differ are written back.
  const sourceNotes = readAllNotes(cwd, sourceRef);
  const localNotes = readAllNotes(cwd, NOTES_REF);
  for (const [commitSha, sourceNote] of sourceNotes) {
    const localNote = localNotes.get(commitSha);
    if (!localNote) {
      writeNote(commitSha, sourceNote, cwd);
    } else if (JSON.stringify(localNote) !== JSON.stringify(sourceNote)) {
      writeNote(commitSha, mergeNoteVersions(localNote, sourceNote), cwd);
    }
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
    mergeRefIntoLocalNotes(REMOTE_TMP_REF, cwd);
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
 * Pull the notes ref from a remote and merge it into the local notes, so a
 * fresh checkout (or one that hasn't fetched notes) sees stamps without a
 * manual `git fetch refs/notes/wick`. Non-destructive by construction: the
 * remote is fetched into a temp ref and merged per commit (mergeNoteVersions,
 * per-class max), so unpushed local stamps are preserved, never clobbered.
 * Best-effort — every failure mode returns a status instead of throwing so
 * the caller (wick report) can proceed with whatever is already local.
 */
export function syncNotesFromRemote(
  remote: string,
  cwd: string,
): "updated" | "up-to-date" | "no-remote" | "failed" {
  if (tryRun(["config", `remote.${remote}.url`], cwd) === null) return "no-remote";

  // ls-remote distinguishes "remote unreachable" (null) from "remote simply
  // has no notes yet" (empty) — a fetch of a missing ref would just error.
  const remoteListing = tryRun(["ls-remote", remote, NOTES_REF], cwd);
  if (remoteListing === null) return "failed";
  if (remoteListing === "") return "up-to-date";

  const localSha = tryRun(["rev-parse", "--verify", "--quiet", NOTES_REF], cwd);
  if (tryRun(["fetch", "--quiet", remote, `+${NOTES_REF}:${REMOTE_FETCH_TMP_REF}`], cwd) === null) {
    return "failed";
  }
  try {
    const fetchedSha = tryRun(["rev-parse", "--verify", "--quiet", REMOTE_FETCH_TMP_REF], cwd);
    if (!fetchedSha) return "up-to-date";
    if (localSha === fetchedSha) return "up-to-date";
    if (!localSha) {
      // Fresh checkout with no local notes — adopt the remote ref wholesale.
      tryRun(["update-ref", NOTES_REF, fetchedSha], cwd);
      return "updated";
    }
    mergeRefIntoLocalNotes(REMOTE_FETCH_TMP_REF, cwd);
    return "updated";
  } finally {
    tryRun(["update-ref", "-d", REMOTE_FETCH_TMP_REF], cwd);
  }
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
/** Returns true when a note was actually (re)written onto `newCommit`. */
export function remapNotes(oldCommits: string[], newCommit: string, cwd: string): boolean {
  const oldNotes = oldCommits
    .map((c) => readNote(c, cwd))
    .filter((n): n is NoteData => n !== null);
  if (oldNotes.length === 0) return false;

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
  if (current && JSON.stringify(current) === JSON.stringify(merged)) return false;
  writeNote(newCommit, merged, cwd);
  return true;
}
