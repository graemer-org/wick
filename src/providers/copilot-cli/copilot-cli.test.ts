import { describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import * as path from "node:path";
import { createCopilotCliProvider } from "./index.js";
import { TestFactory } from "../../test-factory.js";

const SESSION_ID = "0ab19a8d-a35a-45d5-83cc-30fd7bc06727";

describe("copilot-cli provider", () => {
  it("discovers sessions whose gitRoot matches the repo root", async () => {
    // Arrange
    const { copilotDir, repoPath } = TestFactory.makeCopilotSession({ closed: true });
    const provider = createCopilotCliProvider({ copilotDir });

    // Act
    const refs = await provider.discoverSessions(repoPath);

    // Assert
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: SESSION_ID, provider: "copilot-cli" });
  });

  it("ignores sessions from other repos and missing state dirs", async () => {
    // Arrange — a session pointing at a different gitRoot.
    const { copilotDir, repoPath } = TestFactory.makeCopilotSession({
      closed: true,
      gitRoot: "/somewhere/else",
    });
    const provider = createCopilotCliProvider({ copilotDir });
    const emptyProvider = createCopilotCliProvider({ copilotDir: "/nonexistent/copilot" });

    // Act + Assert — neither the mismatched session nor a missing dir yields refs.
    expect(await provider.discoverSessions(repoPath)).toHaveLength(0);
    expect(await emptyProvider.discoverSessions(repoPath)).toHaveLength(0);
  });

  it("reads full usage from session.shutdown and subtracts cache reads from input", async () => {
    // Arrange
    const { copilotDir, repoPath } = TestFactory.makeCopilotSession({ closed: true });
    const provider = createCopilotCliProvider({ copilotDir });
    const [sessionRef] = await provider.discoverSessions(repoPath);

    // Act
    const usage = await provider.getUsage(sessionRef);

    // Assert
    expect(usage.perModel).toHaveLength(1);
    expect(usage.perModel[0]).toEqual({
      model: "claude-opus-4.8",
      input: 200, // 1000 inclusive − 800 cached
      cacheRead: 800,
      cacheWrite: 40,
      output: 150,
    });
    expect(usage.firstTs).toBe("2026-07-20T10:00:00.000Z");
    expect(usage.lastTs).toBe("2026-07-20T10:30:00.000Z");
  });

  it("falls back to partial output tokens for a live session without DB rows", async () => {
    // Arrange — session has no shutdown event and no session-store rows.
    const { copilotDir, repoPath } = TestFactory.makeCopilotSession({ closed: false });
    const provider = createCopilotCliProvider({ copilotDir });
    const [sessionRef] = await provider.discoverSessions(repoPath);

    // Act
    const usage = await provider.getUsage(sessionRef);

    // Assert — only the output lower bound is known.
    expect(usage.perModel).toEqual([
      { model: "claude-opus-4.8", input: 0, cacheRead: 0, cacheWrite: 0, output: 150 },
    ]);
  });

  const hasSqlite3 = (() => {
    try {
      execSync("sqlite3 -version", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasSqlite3)(
    "prefers session-store.db rows for a live session (same inclusive-input semantics)",
    async () => {
      // Arrange — live session plus per-request rows in the central store
      // (including a foreign session that must not leak into the sums).
      const { copilotDir, repoPath } = TestFactory.makeCopilotSession({ closed: false });
      const storeDbPath = path.join(copilotDir, "session-store.db");
      execFileSync("sqlite3", [
        storeDbPath,
        `CREATE TABLE assistant_usage_events (
           session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
           cache_read_tokens INTEGER, cache_write_tokens INTEGER
         );
         INSERT INTO assistant_usage_events VALUES
           ('${SESSION_ID}', 'claude-opus-4.8', 500, 60, 400, 20),
           ('${SESSION_ID}', 'claude-opus-4.8', 700, 90, 600, 0),
           ('other-session', 'claude-opus-4.8', 999, 99, 0, 0);`,
      ]);
      const provider = createCopilotCliProvider({ copilotDir });
      const [sessionRef] = await provider.discoverSessions(repoPath);

      // Act
      const usage = await provider.getUsage(sessionRef);

      // Assert
      expect(usage.perModel).toEqual([
        {
          model: "claude-opus-4.8",
          input: 200, // (500+700) − (400+600)
          cacheRead: 1000,
          cacheWrite: 20,
          output: 150,
        },
      ]);
    },
  );
});
