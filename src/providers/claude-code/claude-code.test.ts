import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createClaudeCodeProvider, encodeProjectPath } from "./index.js";
import { TestFactory } from "../../test-factory.js";

const SESSION_ID = "e438cfeb-7342-4883-8830-83a718239be2";

describe("encodeProjectPath", () => {
  it("matches the observed on-disk encoding", () => {
    // Act + Assert
    expect(
      encodeProjectPath("/workspace/wick/.claude/worktrees/bridge-cse_0111a"),
    ).toBe("-workspace-wick--claude-worktrees-bridge-cse-0111a");
  });
});

describe("claude-code provider", () => {
  it("dedupes streaming snapshots by message.id, keeping the last occurrence", async () => {
    // Arrange
    const repoRoot = "/fake/repo";
    const claudeDir = TestFactory.makeClaudeTranscript({
      repoRoot,
      sessionId: SESSION_ID,
      lines: [
        TestFactory.claudeAssistantLine("msg_1", "claude-fable-5", { input: 10, output: 100 }),
        TestFactory.claudeAssistantLine("msg_1", "claude-fable-5", { input: 10, output: 250 }), // final snapshot
        TestFactory.claudeAssistantLine("msg_2", "claude-fable-5", { input: 5, output: 50, cacheRead: 1000, cacheWrite: 200 }),
      ],
    });
    const provider = createClaudeCodeProvider({ claudeDir });

    // Act
    const [sessionRef] = await provider.discoverSessions(repoRoot);
    const usage = await provider.getUsage(sessionRef);

    // Assert
    expect(usage.sessionId).toBe(SESSION_ID);
    expect(usage.perModel).toHaveLength(1);
    const modelUsage = usage.perModel[0];
    expect(modelUsage.input).toBe(15); // 10 (final msg_1) + 5, not 10+10+5
    expect(modelUsage.output).toBe(300); // 250 + 50, not 100+250+50
    expect(modelUsage.cacheRead).toBe(1000);
    expect(modelUsage.cacheWrite).toBe(200);
  });

  it("tracks usage per model and first/last timestamps", async () => {
    // Arrange
    const repoRoot = "/fake/repo2";
    const claudeDir = TestFactory.makeClaudeTranscript({
      repoRoot,
      sessionId: SESSION_ID,
      lines: [
        TestFactory.claudeAssistantLine("msg_a", "claude-fable-5", { output: 10 }, "2026-07-19T10:00:00.000Z"),
        TestFactory.claudeAssistantLine("msg_b", "claude-haiku-4-5", { output: 20 }, "2026-07-19T11:00:00.000Z"),
      ],
    });
    const provider = createClaudeCodeProvider({ claudeDir });

    // Act
    const [sessionRef] = await provider.discoverSessions(repoRoot);
    const usage = await provider.getUsage(sessionRef);

    // Assert
    expect(usage.perModel.map((modelUsage) => modelUsage.model).sort()).toEqual([
      "claude-fable-5",
      "claude-haiku-4-5",
    ]);
    expect(usage.firstTs).toBe("2026-07-19T10:00:00.000Z");
    expect(usage.lastTs).toBe("2026-07-19T11:00:00.000Z");
  });

  it("survives corrupt lines and non-assistant records", async () => {
    // Arrange
    const repoRoot = "/fake/repo3";
    const claudeDir = TestFactory.makeClaudeTranscript({
      repoRoot,
      sessionId: SESSION_ID,
      lines: [
        "this is not json {{{",
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        JSON.stringify({ type: "assistant" }), // missing message
        TestFactory.claudeAssistantLine("msg_ok", "claude-fable-5", { output: 42 }),
        "", // blank
      ],
    });
    const provider = createClaudeCodeProvider({ claudeDir });

    // Act
    const [sessionRef] = await provider.discoverSessions(repoRoot);
    const usage = await provider.getUsage(sessionRef);

    // Assert
    expect(usage.perModel[0].output).toBe(42);
  });

  it("includes subagent transcripts under <session-id>/subagents/", async () => {
    // Arrange
    const repoRoot = "/fake/repo4";
    const claudeDir = TestFactory.makeClaudeTranscript({
      repoRoot,
      sessionId: SESSION_ID,
      lines: [TestFactory.claudeAssistantLine("msg_main", "claude-fable-5", { output: 100 })],
    });
    const subagentsDir = path.join(
      claudeDir,
      "projects",
      encodeProjectPath(repoRoot),
      SESSION_ID,
      "subagents",
    );
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      path.join(subagentsDir, "agent-abc123.jsonl"),
      TestFactory.claudeAssistantLine("msg_sub", "claude-fable-5", { output: 30 }),
    );
    const provider = createClaudeCodeProvider({ claudeDir });

    // Act
    const [sessionRef] = await provider.discoverSessions(repoRoot);
    const usage = await provider.getUsage(sessionRef);

    // Assert
    expect(usage.perModel[0].output).toBe(130);
  });

  it("skips reading a transcript unchanged since the `since` cutoff", async () => {
    // Arrange — a transcript whose mtime predates the cutoff (nothing changed).
    const repoRoot = "/fake/repo-skip";
    const claudeDir = TestFactory.makeClaudeTranscript({
      repoRoot,
      sessionId: SESSION_ID,
      lines: [TestFactory.claudeAssistantLine("msg_old", "claude-fable-5", { output: 500 })],
    });
    const transcriptPath = path.join(
      claudeDir,
      "projects",
      encodeProjectPath(repoRoot),
      `${SESSION_ID}.jsonl`,
    );
    const transcriptMtime = new Date("2026-07-01T00:00:00.000Z");
    utimesSync(transcriptPath, transcriptMtime, transcriptMtime);
    const provider = createClaudeCodeProvider({ claudeDir });
    const [sessionRef] = await provider.discoverSessions(repoRoot);

    // Act — stamp path passes a cutoff AFTER the transcript's mtime.
    const usage = await provider.getUsage(sessionRef, { since: "2026-07-02T00:00:00.000Z" });

    // Assert — skipped: empty usage stands in for "zero delta", not read.
    expect(usage.perModel).toEqual([]);
    expect(usage.sessionId).toBe(SESSION_ID);
  });

  it("re-reads a transcript modified after the `since` cutoff", async () => {
    // Arrange — a transcript whose mtime is newer than the cutoff.
    const repoRoot = "/fake/repo-fresh";
    const claudeDir = TestFactory.makeClaudeTranscript({
      repoRoot,
      sessionId: SESSION_ID,
      lines: [TestFactory.claudeAssistantLine("msg_new", "claude-fable-5", { output: 500 })],
    });
    const transcriptPath = path.join(
      claudeDir,
      "projects",
      encodeProjectPath(repoRoot),
      `${SESSION_ID}.jsonl`,
    );
    const transcriptMtime = new Date("2026-07-03T00:00:00.000Z");
    utimesSync(transcriptPath, transcriptMtime, transcriptMtime);
    const provider = createClaudeCodeProvider({ claudeDir });
    const [sessionRef] = await provider.discoverSessions(repoRoot);

    // Act — cutoff predates the transcript's mtime.
    const usage = await provider.getUsage(sessionRef, { since: "2026-07-02T00:00:00.000Z" });

    // Assert — parsed normally.
    expect(usage.perModel[0].output).toBe(500);
  });

  it("does not skip when a subagent transcript is newer than the cutoff", async () => {
    // Arrange — a stale main transcript but a subagent modified after the cutoff.
    const repoRoot = "/fake/repo-subskip";
    const claudeDir = TestFactory.makeClaudeTranscript({
      repoRoot,
      sessionId: SESSION_ID,
      lines: [TestFactory.claudeAssistantLine("msg_main", "claude-fable-5", { output: 100 })],
    });
    const projectDir = path.join(claudeDir, "projects", encodeProjectPath(repoRoot));
    const transcriptPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    const stale = new Date("2026-07-01T00:00:00.000Z");
    utimesSync(transcriptPath, stale, stale);
    const subagentsDir = path.join(projectDir, SESSION_ID, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const subagentPath = path.join(subagentsDir, "agent-fresh.jsonl");
    writeFileSync(
      subagentPath,
      TestFactory.claudeAssistantLine("msg_sub", "claude-fable-5", { output: 30 }),
    );
    const fresh = new Date("2026-07-03T00:00:00.000Z");
    utimesSync(subagentPath, fresh, fresh);
    const provider = createClaudeCodeProvider({ claudeDir });
    const [sessionRef] = await provider.discoverSessions(repoRoot);

    // Act — cutoff sits between the two mtimes.
    const usage = await provider.getUsage(sessionRef, { since: "2026-07-02T00:00:00.000Z" });

    // Assert — the newer subagent forces a full read (main + subagent).
    expect(usage.perModel[0].output).toBe(130);
  });

  it("returns an empty session list when the repo has no transcripts", async () => {
    // Arrange
    const claudeDir = mkdtempSync(path.join(tmpdir(), "wick-claude-empty-"));
    const provider = createClaudeCodeProvider({ claudeDir });

    // Act
    const refs = await provider.discoverSessions("/nowhere");

    // Assert
    expect(refs).toEqual([]);
  });

  it("ignores non-session files like *.ccr-tip.json", async () => {
    // Arrange
    const repoRoot = "/fake/repo5";
    const claudeDir = TestFactory.makeClaudeTranscript({
      repoRoot,
      sessionId: SESSION_ID,
      lines: [TestFactory.claudeAssistantLine("msg_single", "claude-fable-5", { output: 1 })],
    });
    const projectDir = path.join(claudeDir, "projects", encodeProjectPath(repoRoot));
    writeFileSync(path.join(projectDir, `${SESSION_ID}.ccr-tip.json`), "{}");
    writeFileSync(path.join(projectDir, "not-a-uuid.jsonl"), "{}");
    const provider = createClaudeCodeProvider({ claudeDir });

    // Act
    const refs = await provider.discoverSessions(repoRoot);

    // Assert
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(SESSION_ID);
  });
});
