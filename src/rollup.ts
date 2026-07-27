import { execFileSync, spawn } from "node:child_process";
import type { NoteData } from "./attribution.js";
import { git, tryGit } from "./git.js";
import { NOTES_REF } from "./notes.js";
import { costUsd, type PricingTable, type TokenCounts } from "./pricing.js";
import type { AuthorReport, Report } from "./report.js";

/**
 * Incremental cost rollup — the O(1)/O(Δ) path behind a full-history
 * `wick report`/`wick badge`.
 *
 * The per-commit report walks every commit in range and reads a note per
 * commit; on the default branch that is O(all commits) and, once a repo has
 * millions of stamped commits, seconds-to-minutes and unbounded memory. That
 * is fine for a bounded PR range (small) but not for full history.
 *
 * A rollup is the aggregate a full-history report needs — per-model token
 * totals, a by-author split, and unique-session/stamped-commit counts — folded
 * once and then maintained incrementally. It is:
 *  - keyed to the exact `(HEAD sha, notes-ref sha)` it was computed at, so it
 *    can never silently disagree with the notes (the source of truth): any
 *    mismatch it cannot cheaply reconcile forces a full recompute;
 *  - additive with set-union, so extending HEAD by new commits is a fold of
 *    just the new range (`prev.head..HEAD`) into the stored aggregate;
 *  - persisted in a pushed ref (`refs/wick/rollup`) so a fresh CI checkout
 *    fetches the aggregate instead of rebuilding it cold.
 *
 * The aggregate carries totals + by-author ONLY — a million-row per-commit
 * table is both unusable and the very thing that forces O(all commits), so the
 * full-history report omits it (bounded ranges still render every commit).
 */

/** The pushed ref the rollup blob lives under. */
export const ROLLUP_REF = "refs/wick/rollup";

/** US (0x1f) — separates fields in the `git log` format and map keys; never
 * appears in a sha, author name, or JSON note body. */
const SEP = "\x1f";

const emptyTokens = (): TokenCounts => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

interface AuthorAgg {
  author: string;
  authorEmail: string;
  stampedCommits: number;
  perModel: Map<string, TokenCounts>;
  sessions: Set<string>;
}

/** The folded aggregate over a set of stamped commits. */
export interface RollupAgg {
  /** provider\x1fmodel → summed tokens. */
  perModel: Map<string, TokenCounts>;
  /** authorKey → per-author aggregate. */
  byAuthor: Map<string, AuthorAgg>;
  /** unique `provider:id` across every folded commit. */
  sessions: Set<string>;
  stampedCommits: number;
}

/** A persisted rollup: the aggregate plus the state it reflects. */
export interface Rollup {
  head: string;
  notes: string;
  /** Total commits reachable from `head` — cached so the warm/incremental path
   * never re-counts full history (an O(all commits) walk without a
   * commit-graph). Feeds the report's "stamped / total" line. */
  commitCount: number;
  agg: RollupAgg;
}

export function emptyAgg(): RollupAgg {
  return { perModel: new Map(), byAuthor: new Map(), sessions: new Set(), stampedCommits: 0 };
}

function addTokens(into: Map<string, TokenCounts>, key: string, s: TokenCounts): void {
  const t = into.get(key) ?? emptyTokens();
  t.input += s.input;
  t.cacheRead += s.cacheRead;
  t.cacheWrite += s.cacheWrite;
  t.output += s.output;
  into.set(key, t);
}

/**
 * Fold one commit's note into the aggregate. Adds each session's tokens to the
 * global and per-author per-model buckets, dedups session identities, and
 * counts the commit once (per author and overall) — matching how `buildReport`
 * aggregates a per-commit note.
 */
export function foldNote(agg: RollupAgg, note: NoteData, author: string, authorEmail: string): void {
  agg.stampedCommits++;
  const authorKey = authorEmail || author;
  const bucket = agg.byAuthor.get(authorKey) ?? {
    author,
    authorEmail,
    stampedCommits: 0,
    perModel: new Map<string, TokenCounts>(),
    sessions: new Set<string>(),
  };
  bucket.stampedCommits++;
  for (const s of note.sessions) {
    const key = `${s.provider}${SEP}${s.model}`;
    addTokens(agg.perModel, key, s);
    addTokens(bucket.perModel, key, s);
    agg.sessions.add(`${s.provider}:${s.id}`);
    bucket.sessions.add(s.id);
  }
  agg.byAuthor.set(authorKey, bucket);
}

/**
 * Stream `git log <revs>` with each commit's author and inline wick note,
 * folding every stamped commit into `agg`. Streamed (NUL-delimited records,
 * bounded memory) so a cold full-history fold never buffers the whole log.
 * Resolves even when the range is empty or unborn (git exits non-zero) — the
 * caller treats that as "nothing to fold".
 */
function walkAndFold(cwd: string, revs: string[], agg: RollupAgg): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["log", `--format=%H${SEP}%aN${SEP}%aE${SEP}%N`, "-z", `--notes=${NOTES_REF}`, ...revs],
      { cwd, stdio: ["ignore", "pipe", "ignore"] },
    );
    let leftover = "";
    const handle = (record: string): void => {
      if (!record) return;
      // %H \x1f author \x1f email \x1f note(JSON, maybe trailing newline)
      const first = record.indexOf(SEP);
      const second = record.indexOf(SEP, first + 1);
      const third = record.indexOf(SEP, second + 1);
      if (third === -1) return;
      const author = record.slice(first + 1, second);
      const authorEmail = record.slice(second + 1, third);
      const raw = record.slice(third + 1);
      if (!raw.trim()) return; // unstamped commit
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return; // malformed note — treat as absent
      }
      if (isNoteData(data)) foldNote(agg, data, author, authorEmail);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      leftover += chunk;
      let idx: number;
      while ((idx = leftover.indexOf("\0")) !== -1) {
        handle(leftover.slice(0, idx));
        leftover = leftover.slice(idx + 1);
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      handle(leftover); // final record has no trailing NUL
      resolve(); // empty/unborn range → nothing folded, not an error
    });
  });
}

function isNoteData(value: unknown): value is NoteData {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { v?: unknown }).v === 1 &&
    Array.isArray((value as { sessions?: unknown }).sessions)
  );
}

/** Additively merge `src` into `target` (per-model sums, session set-union). */
function mergeAggInto(target: RollupAgg, src: RollupAgg): void {
  target.stampedCommits += src.stampedCommits;
  for (const [key, tokens] of src.perModel) addTokens(target.perModel, key, tokens);
  for (const id of src.sessions) target.sessions.add(id);
  for (const [authorKey, srcBucket] of src.byAuthor) {
    const bucket = target.byAuthor.get(authorKey) ?? {
      author: srcBucket.author,
      authorEmail: srcBucket.authorEmail,
      stampedCommits: 0,
      perModel: new Map<string, TokenCounts>(),
      sessions: new Set<string>(),
    };
    bucket.stampedCommits += srcBucket.stampedCommits;
    for (const [key, tokens] of srcBucket.perModel) addTokens(bucket.perModel, key, tokens);
    for (const id of srcBucket.sessions) bucket.sessions.add(id);
    target.byAuthor.set(authorKey, bucket);
  }
}

/** Commit shas whose note blob differs between two notes-ref states. */
function notesChangedCommits(cwd: string, oldNotes: string, newNotes: string): Set<string> {
  const out = tryGit(["diff", "--name-only", oldNotes, newNotes], cwd);
  const changed = new Set<string>();
  if (!out) return changed;
  for (const path of out.split("\n")) {
    const sha = path.replace(/\//g, "").trim();
    if (sha) changed.add(sha);
  }
  return changed;
}

/**
 * Compute or incrementally update the rollup for HEAD's full history.
 *
 * Fast paths, in order:
 *  1. `(head, notes)` unchanged → the stored aggregate is already exact.
 *  2. HEAD fast-forwarded and every changed note is on a newly-reachable commit
 *     (`prev.head..HEAD`) → fold only the new range into the stored aggregate.
 *  3. otherwise (history rewritten, or a note on an already-counted commit
 *     changed) → recompute from scratch, since the aggregate can't be cheaply
 *     corrected without re-reading.
 */
export async function updateRollup(
  cwd: string,
  prev: Rollup | null,
  head: string,
  notes: string | null,
): Promise<Rollup> {
  if (prev && prev.head === head && prev.notes === (notes ?? "")) return prev;

  // Incremental fold is only sound when both note states exist to diff (so we
  // can prove every changed note is on a newly-reachable commit) and HEAD only
  // grew. First-ever notes, a deleted notes ref, or a rewritten HEAD all fall
  // through to a full recompute — correctness over a marginal speedup.
  if (prev && notes !== null && prev.notes !== "" && isAncestor(cwd, prev.head, head)) {
    const changed = notesChangedCommits(cwd, prev.notes, notes);
    const newRange = rangeCommits(cwd, `${prev.head}..${head}`);
    const newRangeSet = new Set(newRange);
    const touchesCounted = [...changed].some((sha) => !newRangeSet.has(sha));
    if (!touchesCounted) {
      const delta = emptyAgg();
      await walkAndFold(cwd, [`${prev.head}..${head}`], delta);
      const agg = cloneAgg(prev.agg);
      mergeAggInto(agg, delta);
      return { head, notes: notes ?? "", commitCount: prev.commitCount + newRange.length, agg };
    }
  }

  const agg = emptyAgg();
  await walkAndFold(cwd, [head], agg);
  return { head, notes: notes ?? "", commitCount: countCommits(cwd, head), agg };
}

/** Total commits reachable from `rev` — O(1) with a commit-graph, O(N) without. */
function countCommits(cwd: string, rev: string): number {
  const out = tryGit(["rev-list", "--count", rev], cwd);
  return out ? Number(out) : 0;
}

function isAncestor(cwd: string, maybeAncestor: string, descendant: string): boolean {
  // exit 0 → ancestor; 1 → not; other → error (treated as not, forcing recompute)
  try {
    git(["merge-base", "--is-ancestor", maybeAncestor, descendant], cwd);
    return true;
  } catch {
    return false;
  }
}

function rangeCommits(cwd: string, range: string): string[] {
  const out = tryGit(["rev-list", range], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

function cloneAgg(agg: RollupAgg): RollupAgg {
  const copy = emptyAgg();
  mergeAggInto(copy, agg);
  return copy;
}

// ---------------------------------------------------------------- persistence

/** Read the rollup blob from the local ref, or null when absent/unparseable. */
export function readRollup(cwd: string): Rollup | null {
  const blob = tryGit(["cat-file", "-p", ROLLUP_REF], cwd);
  if (!blob) return null;
  return deserializeRollup(blob);
}

/**
 * Push the rollup ref to the remote so a fresh checkout (a new CI runner)
 * fetches the aggregate instead of rebuilding it cold. Force-push is safe: the
 * ref is a derived cache with no history to preserve — `updateRollup` validates
 * whatever it starts from against the current `(HEAD, notes)` and recomputes if
 * it can't reconcile. A no-op when nothing has been computed locally yet.
 */
export function syncRollupToRemote(remote: string, cwd: string): "pushed" | "skipped" | "failed" {
  if (!tryGit(["rev-parse", "--verify", "--quiet", ROLLUP_REF], cwd)) return "skipped";
  const ok = tryGit(["push", "--no-verify", "--force", remote, `${ROLLUP_REF}:${ROLLUP_REF}`], cwd) !== null;
  return ok ? "pushed" : "failed";
}

/**
 * Adopt the remote rollup ONLY when there is no local one — a fresh checkout
 * gets the precomputed aggregate, while a machine that already has a (>= as
 * fresh) local rollup keeps it. Never clobbers a local rollup, so it can't
 * regress a machine that has been stamping. Best-effort.
 */
export function syncRollupFromRemote(
  remote: string,
  cwd: string,
): "updated" | "up-to-date" | "no-remote" | "failed" {
  if (tryGit(["rev-parse", "--verify", "--quiet", ROLLUP_REF], cwd)) return "up-to-date";
  if (tryGit(["config", `remote.${remote}.url`], cwd) === null) return "no-remote";
  const listing = tryGit(["ls-remote", remote, ROLLUP_REF], cwd);
  if (listing === null) return "failed";
  if (listing === "") return "up-to-date"; // remote has no rollup yet
  const ok = tryGit(["fetch", "--quiet", remote, `${ROLLUP_REF}:${ROLLUP_REF}`], cwd) !== null;
  return ok ? "updated" : "failed";
}

/** Write the rollup as a blob and point the local ref at it. */
export function writeRollup(cwd: string, rollup: Rollup): void {
  let sha: string;
  try {
    // hash-object reads the blob from stdin; git()/tryGit() take no input.
    sha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd,
      input: serializeRollup(rollup),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
  } catch {
    return; // best-effort cache write — a failure just means a recompute next run
  }
  tryGit(["update-ref", ROLLUP_REF, sha], cwd);
}

interface SerializedAuthor {
  author: string;
  authorEmail: string;
  stampedCommits: number;
  perModel: Record<string, TokenCounts>;
  sessions: string[];
}
interface SerializedRollup {
  v: 1;
  head: string;
  notes: string;
  commitCount: number;
  stampedCommits: number;
  perModel: Record<string, TokenCounts>;
  sessions: string[];
  byAuthor: Record<string, SerializedAuthor>;
}

function serializeRollup(rollup: Rollup): string {
  const byAuthor: Record<string, SerializedAuthor> = {};
  for (const [key, b] of rollup.agg.byAuthor) {
    byAuthor[key] = {
      author: b.author,
      authorEmail: b.authorEmail,
      stampedCommits: b.stampedCommits,
      perModel: Object.fromEntries(b.perModel),
      sessions: [...b.sessions],
    };
  }
  const payload: SerializedRollup = {
    v: 1,
    head: rollup.head,
    notes: rollup.notes,
    commitCount: rollup.commitCount,
    stampedCommits: rollup.agg.stampedCommits,
    perModel: Object.fromEntries(rollup.agg.perModel),
    sessions: [...rollup.agg.sessions],
    byAuthor,
  };
  return JSON.stringify(payload);
}

function deserializeRollup(blob: string): Rollup | null {
  let parsed: SerializedRollup;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  if (!parsed || parsed.v !== 1 || typeof parsed.head !== "string") return null;
  const agg = emptyAgg();
  agg.stampedCommits = parsed.stampedCommits ?? 0;
  for (const [key, t] of Object.entries(parsed.perModel ?? {})) agg.perModel.set(key, { ...t });
  for (const id of parsed.sessions ?? []) agg.sessions.add(id);
  for (const [key, b] of Object.entries(parsed.byAuthor ?? {})) {
    agg.byAuthor.set(key, {
      author: b.author,
      authorEmail: b.authorEmail,
      stampedCommits: b.stampedCommits,
      perModel: new Map(Object.entries(b.perModel ?? {}).map(([k, t]) => [k, { ...t }])),
      sessions: new Set(b.sessions ?? []),
    });
  }
  return { head: parsed.head, notes: parsed.notes ?? "", commitCount: parsed.commitCount ?? 0, agg };
}

// ------------------------------------------------------------ agg → Report

function sumTokens(perModel: Map<string, TokenCounts>): TokenCounts {
  const t = emptyTokens();
  for (const m of perModel.values()) {
    t.input += m.input;
    t.cacheRead += m.cacheRead;
    t.cacheWrite += m.cacheWrite;
    t.output += m.output;
  }
  return t;
}

/**
 * Price a per-model token map, following the report's convention: an unknown
 * model contributes tokens but no cost and is recorded in `unknownModels`;
 * `costUsd` is null only when nothing at all could be priced.
 */
function priceModels(
  perModel: Map<string, TokenCounts>,
  pricing: PricingTable,
): { costUsd: number | null; unknownModels: Set<string> } {
  const unknownModels = new Set<string>();
  let total = 0;
  let sawUnknown = false;
  for (const [key, tokens] of perModel) {
    const [provider, model] = key.split(SEP);
    const c = costUsd(pricing, provider, model, tokens);
    if (c === null) {
      sawUnknown = true;
      unknownModels.add(`${provider}/${model}`);
    } else {
      total += c;
    }
  }
  return { costUsd: sawUnknown && total === 0 ? null : total, unknownModels };
}

/**
 * Full-history report for HEAD, served from the incremental rollup: read the
 * cached aggregate, bring it up to date for the current `(HEAD, notes)` (O(Δ)
 * in the common fast-forward case, a one-time cold fold otherwise), persist it
 * back to the local ref, and render totals + by-author. The push of
 * `refs/wick/rollup` to the remote is the caller's job (pre-push / CI), same as
 * the notes ref.
 */
export async function rollupReport(cwd: string, pricing: PricingTable): Promise<Report> {
  const head = tryGit(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
  if (!head) return aggToReport(emptyAgg(), pricing, 0, "HEAD"); // unborn repo

  const notes = tryGit(["rev-parse", "--verify", "--quiet", NOTES_REF], cwd);
  const prev = readRollup(cwd);
  const rollup = await updateRollup(cwd, prev, head, notes);
  if (rollup !== prev) writeRollup(cwd, rollup);

  return aggToReport(rollup.agg, pricing, rollup.commitCount, "HEAD");
}

/**
 * Render a rollup aggregate as a `Report` — totals + by-author, no per-commit
 * rows (`omittedCommitRows: true`). `totalCommits` is HEAD's full commit count
 * (for the "stamped/total" line); it is O(1) off the commit-graph.
 */
export function aggToReport(
  agg: RollupAgg,
  pricing: PricingTable,
  totalCommits: number,
  range: string,
): Report {
  const totalsTokens = sumTokens(agg.perModel);
  const totalsPricing = priceModels(agg.perModel, pricing);

  const authors: AuthorReport[] = [...agg.byAuthor.values()]
    .map((b) => {
      const p = priceModels(b.perModel, pricing);
      return {
        author: b.author,
        authorEmail: b.authorEmail,
        stampedCommits: b.stampedCommits,
        sessions: b.sessions.size,
        tokens: sumTokens(b.perModel),
        costUsd: p.costUsd,
      };
    })
    .sort((x, y) => (y.costUsd ?? 0) - (x.costUsd ?? 0));

  const unknownModels = new Set(totalsPricing.unknownModels);

  return {
    range,
    commits: [],
    omittedCommitRows: true,
    authors,
    totals: {
      tokens: totalsTokens,
      costUsd: totalsPricing.costUsd,
      sessions: agg.sessions.size,
      stampedCommits: agg.stampedCommits,
      commits: totalCommits,
    },
    unknownModels: [...unknownModels],
  };
}
