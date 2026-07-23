import type { ModelUsage, SessionRef, SessionUsage } from "./providers/types.js";

/**
 * Session → commit attribution.
 *
 * Wick records, per session and model, the cumulative token totals as of the
 * last stamp. On each new commit the stamp is the DELTA between the session's
 * current totals and the recorded baseline — so a session spanning several
 * commits distributes its tokens across them without double-counting
 * (sum of stamps == session total).
 */

export interface NoteSession {
  id: string;
  provider: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface NoteData {
  v: 1;
  sessions: NoteSession[];
}

/** sessionKey -> model -> cumulative counts at last stamp */
export type SessionBaselines = Record<string, Record<string, Omit<ModelUsage, "model">>>;

export interface StampState {
  v: 1;
  lastStampTs: string | null;
  sessions: SessionBaselines;
  /**
   * Session keys that were absent from discovery on the PREVIOUS run — the
   * first strike of the two-strike prune (see computeDelta). Optional so
   * pre-existing state.json files load unchanged.
   */
  pendingPrune?: string[];
}

export function emptyState(): StampState {
  return { v: 1, lastStampTs: null, sessions: {}, pendingPrune: [] };
}

function sessionKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

export interface DeltaResult {
  stamps: NoteSession[];
  newState: StampState;
}

/**
 * Compute the per-session, per-model token delta since the recorded baselines
 * and return the updated baselines. Pure function — the caller persists state.
 *
 * `discovered` (the sessions that still exist on disk this run) prunes stale
 * baselines so state.json can't grow unbounded over a repo's life. Pruning is
 * keyed on actual disappearance, never age: resurfacing a pruned session would
 * re-stamp its full cumulative total against a zeroed baseline. Two guards keep
 * a transient miss from triggering that double-count:
 *   1. Scoped to providers that returned ≥1 session — a provider that returned
 *      nothing may just be temporarily unreadable.
 *   2. Two-strike: a baseline is dropped only after its session is absent on
 *      two consecutive runs. Some providers' discovery reads file content
 *      (copilot-cli matches gitRoot in each events.jsonl head) and can silently
 *      drop one session on a transient read error while staying "live"; the
 *      grace run absorbs that blip.
 */
export function computeDelta(
  current: SessionUsage[],
  state: StampState,
  now: string = new Date().toISOString(),
  discovered?: readonly SessionRef[],
): DeltaResult {
  const stamps: NoteSession[] = [];
  const newSessions: SessionBaselines = { ...state.sessions };

  for (const usage of current) {
    const key = sessionKey(usage.provider, usage.sessionId);
    const baseline = state.sessions[key] ?? {};
    const nextBaseline: Record<string, Omit<ModelUsage, "model">> = {
      ...baseline,
    };
    for (const m of usage.perModel) {
      const prior = baseline[m.model] ?? {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      };
      const delta = {
        input: Math.max(0, m.input - prior.input),
        cacheRead: Math.max(0, m.cacheRead - prior.cacheRead),
        cacheWrite: Math.max(0, m.cacheWrite - prior.cacheWrite),
        output: Math.max(0, m.output - prior.output),
      };
      if (delta.input || delta.cacheRead || delta.cacheWrite || delta.output) {
        stamps.push({
          id: usage.sessionId,
          provider: usage.provider,
          model: m.model,
          ...delta,
        });
      }
      // Baselines are monotonic: a transcript read that races with the
      // provider rewriting the file (or a truncated file) can report totals
      // BELOW what was already stamped. Lowering the baseline would make the
      // next stamp double-count those tokens, so we only ever raise it.
      nextBaseline[m.model] = {
        input: Math.max(prior.input, m.input),
        cacheRead: Math.max(prior.cacheRead, m.cacheRead),
        cacheWrite: Math.max(prior.cacheWrite, m.cacheWrite),
        output: Math.max(prior.output, m.output),
      };
    }
    newSessions[key] = nextBaseline;
  }

  let pendingPrune = state.pendingPrune ?? [];
  if (discovered) {
    const liveKeys = new Set<string>();
    const liveProviders = new Set<string>();
    for (const ref of discovered) {
      liveKeys.add(sessionKey(ref.provider, ref.id));
      liveProviders.add(ref.provider);
    }
    const priorlyAbsent = new Set(pendingPrune);
    const nextPending: string[] = [];
    for (const key of Object.keys(newSessions)) {
      const providerId = key.slice(0, key.indexOf(":"));
      const absent = liveProviders.has(providerId) && !liveKeys.has(key);
      if (!absent) continue; // present (or its provider went silent) — no strike
      if (priorlyAbsent.has(key)) {
        delete newSessions[key]; // absent two runs running — prune for real
      } else {
        nextPending.push(key); // first strike — keep the baseline one more run
      }
    }
    pendingPrune = nextPending;
  }

  return {
    stamps,
    newState: { v: 1, lastStampTs: now, sessions: newSessions, pendingPrune },
  };
}

/** Merge two note payloads, summing entries with the same (id, provider, model). */
export function mergeNotes(a: NoteData, b: NoteData): NoteData {
  const byKey = new Map<string, NoteSession>();
  for (const s of [...a.sessions, ...b.sessions]) {
    const key = `${s.provider}:${s.id}:${s.model}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.input += s.input;
      existing.cacheRead += s.cacheRead;
      existing.cacheWrite += s.cacheWrite;
      existing.output += s.output;
    } else {
      byKey.set(key, { ...s });
    }
  }
  return { v: 1, sessions: [...byKey.values()] };
}

/**
 * Merge two VERSIONS of the same note (local vs remote copy that diverged),
 * taking the per-class MAX for entries with the same (id, provider, model).
 *
 * Not mergeNotes: that sums, which is right when combining fresh deltas into
 * one stamp but double-counts when one side is simply a stale copy of the
 * other. A stamp's counts for a given session key only ever grow (upsert
 * merges more delta in), so max reconciles stale-vs-fresh correctly, and
 * entries unique to one side (e.g. stamps from another machine — session ids
 * are unique per machine) are carried over as-is.
 */
export function mergeNoteVersions(a: NoteData, b: NoteData): NoteData {
  const byKey = new Map<string, NoteSession>();
  for (const s of [...a.sessions, ...b.sessions]) {
    const key = `${s.provider}:${s.id}:${s.model}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.input = Math.max(existing.input, s.input);
      existing.cacheRead = Math.max(existing.cacheRead, s.cacheRead);
      existing.cacheWrite = Math.max(existing.cacheWrite, s.cacheWrite);
      existing.output = Math.max(existing.output, s.output);
    } else {
      byKey.set(key, { ...s });
    }
  }
  return { v: 1, sessions: [...byKey.values()] };
}
