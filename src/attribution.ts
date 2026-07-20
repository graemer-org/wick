import type { ModelUsage, SessionUsage } from "./providers/types.js";

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
}

export function emptyState(): StampState {
  return { v: 1, lastStampTs: null, sessions: {} };
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
 */
export function computeDelta(
  current: SessionUsage[],
  state: StampState,
  now: string = new Date().toISOString(),
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

  return {
    stamps,
    newState: { v: 1, lastStampTs: now, sessions: newSessions },
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
