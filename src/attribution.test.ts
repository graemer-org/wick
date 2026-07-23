import { describe, expect, it } from "vitest";
import { computeDelta, emptyState, mergeNotes, mergeNoteVersions } from "./attribution.js";
import { TestFactory } from "./test-factory.js";

describe("computeDelta", () => {
  it("attributes a session spanning 3 commits without double-counting", () => {
    // Arrange — a session whose cumulative output grows across three commits.
    let state = emptyState();
    const stampedPerCommit: number[] = [];

    // Act
    for (const cumulativeOutput of [100, 250, 400]) {
      const { stamps, newState } = computeDelta(
        [TestFactory.makeSessionUsage("session-1", "claude-fable-5", { output: cumulativeOutput })],
        state,
      );
      stampedPerCommit.push(stamps.reduce((sum, stamp) => sum + stamp.output, 0));
      state = newState;
    }

    // Assert — each commit gets its delta, and the deltas sum to the total.
    expect(stampedPerCommit).toEqual([100, 150, 150]);
    expect(stampedPerCommit.reduce((sum, delta) => sum + delta, 0)).toBe(400);
  });

  it("emits no stamp when nothing changed", () => {
    // Arrange
    const firstStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 100 })],
      emptyState(),
    );

    // Act
    const secondStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 100 })],
      firstStamp.newState,
    );

    // Assert
    expect(secondStamp.stamps).toEqual([]);
  });

  it("keeps per-model deltas separate", () => {
    // Act
    const firstStamp = computeDelta(
      [
        {
          sessionId: "session-1",
          provider: "claude-code",
          perModel: [
            { model: "model-a", input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
            { model: "model-b", input: 0, cacheRead: 0, cacheWrite: 0, output: 20 },
          ],
          firstTs: "",
          lastTs: "",
        },
      ],
      emptyState(),
    );

    // Assert
    expect(firstStamp.stamps).toHaveLength(2);
    expect(firstStamp.stamps.find((stamp) => stamp.model === "model-a")?.output).toBe(10);
    expect(firstStamp.stamps.find((stamp) => stamp.model === "model-b")?.output).toBe(20);
  });

  it("keeps baselines for sessions absent from the current scan", () => {
    // Arrange
    const firstStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 100 })],
      emptyState(),
    );
    // session-1's transcript temporarily unreadable; only session-2 is seen.
    const secondStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-2", "model-1", { output: 5 })],
      firstStamp.newState,
    );

    // Act — session-1 reappears with more usage; only its delta counts.
    const thirdStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 120 })],
      secondStamp.newState,
    );

    // Assert
    expect(thirdStamp.stamps).toHaveLength(1);
    expect(thirdStamp.stamps[0].output).toBe(20);
  });

  it("clamps negative deltas (e.g. truncated transcript) to zero", () => {
    // Arrange
    const firstStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 100 })],
      emptyState(),
    );

    // Act
    const secondStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 50 })],
      firstStamp.newState,
    );

    // Assert
    expect(secondStamp.stamps).toEqual([]);
  });

  it("never lowers baselines on a shrunken read, so already-stamped tokens are not re-stamped", () => {
    // Arrange
    const firstStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 100 })],
      emptyState(),
    );

    // Act — a read racing with the provider rewriting the transcript reports
    // less, then the file recovers with genuinely new tokens.
    const shrunkenStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 40 })],
      firstStamp.newState,
    );
    const recoveredStamp = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 120 })],
      shrunkenStamp.newState,
    );

    // Assert
    expect(shrunkenStamp.stamps).toEqual([]);
    expect(recoveredStamp.stamps).toHaveLength(1);
    expect(recoveredStamp.stamps[0].output).toBe(20);
  });

  it("prunes a vanished session's baseline only after two consecutive misses", () => {
    // Arrange — two claude-code sessions get stamped.
    const onlySession1 = [{ id: "session-1", provider: "claude-code", path: "/dev/null" }];
    const first = computeDelta(
      [
        TestFactory.makeSessionUsage("session-1", "model-1", { output: 100 }),
        TestFactory.makeSessionUsage("session-2", "model-1", { output: 200 }),
      ],
      emptyState(),
    );

    // Act — session-2's transcript is gone; only session-1 is discovered, twice.
    const graceRun = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 150 })],
      first.newState,
      undefined,
      onlySession1,
    );
    const pruneRun = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 160 })],
      graceRun.newState,
      undefined,
      onlySession1,
    );

    // Assert — the first miss is a grace run (baseline kept); the second prunes,
    // so state.json can't grow forever but a one-run blip can't drop a baseline.
    expect(Object.keys(graceRun.newState.sessions).sort()).toEqual([
      "claude-code:session-1",
      "claude-code:session-2",
    ]);
    expect(graceRun.newState.pendingPrune).toEqual(["claude-code:session-2"]);
    expect(Object.keys(pruneRun.newState.sessions)).toEqual(["claude-code:session-1"]);
  });

  it("resets the prune strike when a session reappears", () => {
    // Arrange — a stamped session that then misses one run while its provider
    // stays live (a sibling session keeps claude-code discoverable).
    const first = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 100 })],
      emptyState(),
    );
    const strike = computeDelta(
      [],
      first.newState,
      undefined,
      [{ id: "sibling", provider: "claude-code", path: "/dev/null" }],
    );

    // Act — session-1 is discovered again after its single miss.
    const back = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 120 })],
      strike.newState,
      undefined,
      [{ id: "session-1", provider: "claude-code", path: "/dev/null" }],
    );

    // Assert — the miss recorded a strike, then reappearing cleared it, so a
    // later miss would count from zero rather than pruning immediately.
    expect(strike.newState.pendingPrune).toEqual(["claude-code:session-1"]);
    expect(strike.newState.sessions["claude-code:session-1"]).toBeDefined();
    expect(back.newState.pendingPrune).toEqual([]);
    expect(back.newState.sessions["claude-code:session-1"]).toBeDefined();
  });

  it("does not prune, nor double-count, when a provider returns no sessions", () => {
    // Arrange
    const first = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 100 })],
      emptyState(),
    );

    // Act — discoverSessions momentarily returned nothing (e.g. dir unreadable),
    // then recovered with the same session grown to 150.
    const transient = computeDelta([], first.newState, undefined, []);
    const recovered = computeDelta(
      [TestFactory.makeSessionUsage("session-1", "model-1", { output: 150 })],
      transient.newState,
      undefined,
      [{ id: "session-1", provider: "claude-code", path: "/dev/null" }],
    );

    // Assert — the baseline survived the transient failure, so recovery stamps
    // only the 50-token delta, not the full 150.
    expect(Object.keys(transient.newState.sessions)).toEqual(["claude-code:session-1"]);
    expect(recovered.stamps).toHaveLength(1);
    expect(recovered.stamps[0].output).toBe(50);
  });

  it("only prunes within providers that returned at least one session", () => {
    // Arrange — one claude-code session and one copilot-cli session stamped.
    const first = computeDelta(
      [
        TestFactory.makeSessionUsage("cc-1", "model-1", { output: 100 }),
        {
          sessionId: "cop-1",
          provider: "copilot-cli",
          perModel: [{ model: "m", input: 0, cacheRead: 0, cacheWrite: 0, output: 10 }],
          firstTs: "",
          lastTs: "",
        },
      ],
      emptyState(),
    );

    // Act — only claude-code is discoverable across two runs (Copilot CLI
    // absent), and its session cc-1 vanished.
    const discovered = [{ id: "cc-other", provider: "claude-code", path: "/dev/null" }];
    const graceRun = computeDelta([], first.newState, undefined, discovered);
    const second = computeDelta([], graceRun.newState, undefined, discovered);

    // Assert — cc-1 pruned (its provider was live, it disappeared for two runs);
    // the copilot baseline is kept, since its provider returning nothing could
    // be transient.
    expect(Object.keys(second.newState.sessions)).toEqual(["copilot-cli:cop-1"]);
  });
});

describe("mergeNotes", () => {
  it("sums entries with the same (id, provider, model) and keeps distinct ones", () => {
    // Act
    const merged = mergeNotes(
      TestFactory.makeNote([
        TestFactory.makeSession({ id: "session-1", input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }),
      ]),
      TestFactory.makeNote([
        TestFactory.makeSession({ id: "session-1", input: 10, cacheRead: 20, cacheWrite: 30, output: 40 }),
        TestFactory.makeSession({ id: "session-2", input: 5 }),
      ]),
    );

    // Assert
    expect(merged.sessions).toHaveLength(2);
    const firstSession = merged.sessions.find((session) => session.id === "session-1")!;
    expect(firstSession).toMatchObject({ input: 11, cacheRead: 22, cacheWrite: 33, output: 44 });
  });
});

describe("mergeNoteVersions", () => {
  it("does not double-count when one side is a stale copy of the other", () => {
    // Act — remote holds the old version of the stamp, local the newer one.
    const merged = mergeNoteVersions(
      TestFactory.makeSessionNote({ id: "session-1", output: 150 }),
      TestFactory.makeSessionNote({ id: "session-1", output: 100 }),
    );

    // Assert
    expect(merged.sessions).toHaveLength(1);
    expect(merged.sessions[0].output).toBe(150); // max, not 250
  });

  it("is a no-op for identical versions", () => {
    // Act
    const merged = mergeNoteVersions(
      TestFactory.makeSessionNote({ id: "session-1", output: 100 }),
      TestFactory.makeSessionNote({ id: "session-1", output: 100 }),
    );

    // Assert
    expect(merged.sessions).toHaveLength(1);
    expect(merged.sessions[0].output).toBe(100);
  });

  it("carries over entries unique to either side (other-machine sessions)", () => {
    // Act
    const merged = mergeNoteVersions(
      TestFactory.makeSessionNote({ id: "local-session", output: 10 }),
      TestFactory.makeSessionNote({ id: "remote-session", output: 20 }),
    );

    // Assert
    expect(merged.sessions).toHaveLength(2);
    expect(merged.sessions.map((session) => session.output).sort()).toEqual([10, 20]);
  });
});
