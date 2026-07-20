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
