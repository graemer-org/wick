import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createClaudeCodeProvider, encodeProjectPath } from "./index.js";

const SESSION_ID = "e438cfeb-7342-4883-8830-83a718239be2";

function assistantLine(
  msgId: string,
  model: string,
  usage: Partial<Record<string, number>>,
  ts = "2026-07-19T12:00:00.000Z",
): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `uuid-${msgId}`,
    timestamp: ts,
    sessionId: SESSION_ID,
    message: {
      id: msgId,
      model,
      usage: {
        input_tokens: usage.input ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheWrite ?? 0,
        output_tokens: usage.output ?? 0,
      },
    },
  });
}

function setupClaudeDir(repoRoot: string, lines: string[]): string {
  const claudeDir = mkdtempSync(path.join(tmpdir(), "wick-claude-"));
  const projectDir = path.join(
    claudeDir,
    "projects",
    encodeProjectPath(repoRoot),
  );
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), lines.join("\n"));
  return claudeDir;
}

describe("encodeProjectPath", () => {
  it("matches the observed on-disk encoding", () => {
    expect(
      encodeProjectPath("/workspace/wick/.claude/worktrees/bridge-cse_0111a"),
    ).toBe("-workspace-wick--claude-worktrees-bridge-cse-0111a");
  });
});

describe("claude-code provider", () => {
  it("dedupes streaming snapshots by message.id, keeping the last occurrence", async () => {
    const repo = "/fake/repo";
    const claudeDir = setupClaudeDir(repo, [
      assistantLine("msg_1", "claude-fable-5", { input: 10, output: 100 }),
      assistantLine("msg_1", "claude-fable-5", { input: 10, output: 250 }), // final snapshot
      assistantLine("msg_2", "claude-fable-5", { input: 5, output: 50, cacheRead: 1000, cacheWrite: 200 }),
    ]);
    const provider = createClaudeCodeProvider({ claudeDir });
    const [ref] = await provider.discoverSessions(repo, {});
    const usage = await provider.getUsage(ref);
    expect(usage.sessionId).toBe(SESSION_ID);
    expect(usage.perModel).toHaveLength(1);
    const m = usage.perModel[0];
    expect(m.input).toBe(15); // 10 (final msg_1) + 5, not 10+10+5
    expect(m.output).toBe(300); // 250 + 50, not 100+250+50
    expect(m.cacheRead).toBe(1000);
    expect(m.cacheWrite).toBe(200);
  });

  it("tracks usage per model and first/last timestamps", async () => {
    const repo = "/fake/repo2";
    const claudeDir = setupClaudeDir(repo, [
      assistantLine("msg_a", "claude-fable-5", { output: 10 }, "2026-07-19T10:00:00.000Z"),
      assistantLine("msg_b", "claude-haiku-4-5", { output: 20 }, "2026-07-19T11:00:00.000Z"),
    ]);
    const provider = createClaudeCodeProvider({ claudeDir });
    const [ref] = await provider.discoverSessions(repo, {});
    const usage = await provider.getUsage(ref);
    expect(usage.perModel.map((m) => m.model).sort()).toEqual([
      "claude-fable-5",
      "claude-haiku-4-5",
    ]);
    expect(usage.firstTs).toBe("2026-07-19T10:00:00.000Z");
    expect(usage.lastTs).toBe("2026-07-19T11:00:00.000Z");
  });

  it("survives corrupt lines and non-assistant records", async () => {
    const repo = "/fake/repo3";
    const claudeDir = setupClaudeDir(repo, [
      "this is not json {{{",
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant" }), // missing message
      assistantLine("msg_ok", "claude-fable-5", { output: 42 }),
      "", // blank
    ]);
    const provider = createClaudeCodeProvider({ claudeDir });
    const [ref] = await provider.discoverSessions(repo, {});
    const usage = await provider.getUsage(ref);
    expect(usage.perModel[0].output).toBe(42);
  });

  it("includes subagent transcripts under <session-id>/subagents/", async () => {
    const repo = "/fake/repo4";
    const claudeDir = setupClaudeDir(repo, [
      assistantLine("msg_main", "claude-fable-5", { output: 100 }),
    ]);
    const subDir = path.join(
      claudeDir,
      "projects",
      encodeProjectPath(repo),
      SESSION_ID,
      "subagents",
    );
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      path.join(subDir, "agent-abc123.jsonl"),
      assistantLine("msg_sub", "claude-fable-5", { output: 30 }),
    );
    const provider = createClaudeCodeProvider({ claudeDir });
    const [ref] = await provider.discoverSessions(repo, {});
    const usage = await provider.getUsage(ref);
    expect(usage.perModel[0].output).toBe(130);
  });

  it("returns an empty session list when the repo has no transcripts", async () => {
    const claudeDir = mkdtempSync(path.join(tmpdir(), "wick-claude-empty-"));
    const provider = createClaudeCodeProvider({ claudeDir });
    expect(await provider.discoverSessions("/nowhere", {})).toEqual([]);
  });

  it("ignores non-session files like *.ccr-tip.json", async () => {
    const repo = "/fake/repo5";
    const claudeDir = setupClaudeDir(repo, [
      assistantLine("m", "claude-fable-5", { output: 1 }),
    ]);
    const projectDir = path.join(claudeDir, "projects", encodeProjectPath(repo));
    writeFileSync(path.join(projectDir, `${SESSION_ID}.ccr-tip.json`), "{}");
    writeFileSync(path.join(projectDir, "not-a-uuid.jsonl"), "{}");
    const provider = createClaudeCodeProvider({ claudeDir });
    const refs = await provider.discoverSessions(repo, {});
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(SESSION_ID);
  });
});
