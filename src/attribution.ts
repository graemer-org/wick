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
      nextBaseline[m.model] = {
        input: m.input,
        cacheRead: m.cacheRead,
        cacheWrite: m.cacheWrite,
        output: m.output,
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
