import { describe, expect, it } from "vitest";
import { computeDelta, emptyState, mergeNotes } from "./attribution.js";
import type { SessionUsage } from "./providers/types.js";

function usage(
  sessionId: string,
  model: string,
  totals: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number },
): SessionUsage {
  return {
    sessionId,
    provider: "claude-code",
    perModel: [
      {
        model,
        input: totals.input ?? 0,
        cacheRead: totals.cacheRead ?? 0,
        cacheWrite: totals.cacheWrite ?? 0,
        output: totals.output ?? 0,
      },
    ],
    firstTs: "2026-07-19T10:00:00.000Z",
    lastTs: "2026-07-19T12:00:00.000Z",
  };
}

describe("computeDelta", () => {
  it("attributes a session spanning 3 commits without double-counting", () => {
    // Simulate a session growing across three commits.
    let state = emptyState();
    const stampsPerCommit: number[] = [];

    for (const total of [100, 250, 400]) {
      const { stamps, newState } = computeDelta(
        [usage("s1", "claude-fable-5", { output: total })],
        state,
      );
      stampsPerCommit.push(stamps.reduce((acc, s) => acc + s.output, 0));
      state = newState;
    }

    expect(stampsPerCommit).toEqual([100, 150, 150]);
    // Sum of stamps == session total.
    expect(stampsPerCommit.reduce((a, b) => a + b, 0)).toBe(400);
  });

  it("emits no stamp when nothing changed", () => {
    const first = computeDelta([usage("s1", "m", { output: 100 })], emptyState());
    const second = computeDelta([usage("s1", "m", { output: 100 })], first.newState);
    expect(second.stamps).toEqual([]);
  });

  it("keeps per-model deltas separate", () => {
    const first = computeDelta(
      [
        {
          sessionId: "s1",
          provider: "claude-code",
          perModel: [
            { model: "a", input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
            { model: "b", input: 0, cacheRead: 0, cacheWrite: 0, output: 20 },
          ],
          firstTs: "",
          lastTs: "",
        },
      ],
      emptyState(),
    );
    expect(first.stamps).toHaveLength(2);
    expect(first.stamps.find((s) => s.model === "a")?.output).toBe(10);
    expect(first.stamps.find((s) => s.model === "b")?.output).toBe(20);
  });

  it("keeps baselines for sessions absent from the current scan", () => {
    const first = computeDelta([usage("s1", "m", { output: 100 })], emptyState());
    // s1's transcript temporarily unreadable; only s2 is seen.
    const second = computeDelta([usage("s2", "m", { output: 5 })], first.newState);
    // s1 reappears with more usage — only the delta since its baseline counts.
    const third = computeDelta([usage("s1", "m", { output: 120 })], second.newState);
    expect(third.stamps).toHaveLength(1);
    expect(third.stamps[0].output).toBe(20);
  });

  it("clamps negative deltas (e.g. truncated transcript) to zero", () => {
    const first = computeDelta([usage("s1", "m", { output: 100 })], emptyState());
    const second = computeDelta([usage("s1", "m", { output: 50 })], first.newState);
    expect(second.stamps).toEqual([]);
  });
});

describe("mergeNotes", () => {
  it("sums entries with the same (id, provider, model) and keeps distinct ones", () => {
    const merged = mergeNotes(
      {
        v: 1,
        sessions: [
          { id: "s1", provider: "p", model: "m", input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
        ],
      },
      {
        v: 1,
        sessions: [
          { id: "s1", provider: "p", model: "m", input: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
          { id: "s2", provider: "p", model: "m", input: 5, cacheRead: 0, cacheWrite: 0, output: 0 },
        ],
      },
    );
    expect(merged.sessions).toHaveLength(2);
    const s1 = merged.sessions.find((s) => s.id === "s1")!;
    expect(s1).toMatchObject({ input: 11, cacheRead: 22, cacheWrite: 33, output: 44 });
  });
});
