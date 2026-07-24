/**
 * Shared test data factory. Every test builds its fixtures through
 * `TestFactory` so the suites read the same way and dummy data lives in one
 * place. This module is test-only: it is excluded from the tsc build (see
 * tsconfig `exclude`) and never ships in the npm package.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { NoteData, NoteSession } from "./attribution.js";
import { encodeProjectPath } from "./providers/claude-code/index.js";
import type { SessionUsage, UsageProvider } from "./providers/types.js";
import type { Report } from "./report.js";

export interface CommitAuthor {
  name: string;
  email: string;
}

/** A session whose output can be grown between commits to simulate live usage. */
export interface MutableOutputTotals {
  output: number;
}

export interface ClaudeUsageTotals {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

export interface CopilotShutdownUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

export interface CopilotSessionOptions {
  closed: boolean;
  gitRoot?: string;
  sessionId?: string;
  model?: string;
  shutdownUsage?: CopilotShutdownUsage;
  messageOutputs?: number[];
}

const DEFAULT_TIMESTAMP = "2026-07-19T12:00:00.000Z";
const SESSION_FIRST_TIMESTAMP = "2026-07-19T10:00:00.000Z";
const SESSION_LAST_TIMESTAMP = "2026-07-19T12:00:00.000Z";

const DEFAULT_COPILOT_SESSION_ID = "0ab19a8d-a35a-45d5-83cc-30fd7bc06727";
const DEFAULT_COPILOT_MODEL = "claude-opus-4.8";
const DEFAULT_COPILOT_SHUTDOWN_USAGE: CopilotShutdownUsage = {
  inputTokens: 1000,
  outputTokens: 150,
  cacheReadTokens: 800,
  cacheWriteTokens: 40,
  reasoningTokens: 10,
};

export const TestFactory = {
  // ---------------------------------------------------------------- git ----

  /** Run a git (or other) command in a repo and return trimmed stdout. */
  git(repoPath: string, command: string, ...args: string[]): string {
    return execFileSync(command, args, { cwd: repoPath, encoding: "utf8" }).trim();
  },

  /** Create a fresh git repo with one initial commit; returns its path. */
  makeRepo(): string {
    const repoPath = mkdtempSync(path.join(tmpdir(), "wick-repo-"));
    TestFactory.git(repoPath, "git", "init", "-q", "-b", "main");
    TestFactory.git(repoPath, "git", "config", "user.email", "test@example.com");
    TestFactory.git(repoPath, "git", "config", "user.name", "Test");
    writeFileSync(path.join(repoPath, "file.txt"), "one\n");
    TestFactory.git(repoPath, "git", "add", ".");
    TestFactory.git(repoPath, "git", "commit", "-q", "-m", "initial");
    return repoPath;
  },

  /** Append a line to the tracked file and commit it; returns the new sha. */
  makeCommit(repoPath: string, message: string, author?: CommitAuthor): string {
    writeFileSync(path.join(repoPath, "file.txt"), `${message}\n`, { flag: "a" });
    TestFactory.git(repoPath, "git", "add", ".");
    const authorArgs = author
      ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`]
      : [];
    TestFactory.git(repoPath, "git", ...authorArgs, "commit", "-q", "-m", message);
    return TestFactory.git(repoPath, "git", "rev-parse", "HEAD");
  },

  /** Create a bare repo, wire it as a remote of `repoPath`, and push main. */
  addBareRemote(repoPath: string, remoteName = "origin"): string {
    const remotePath = mkdtempSync(path.join(tmpdir(), "wick-remote-"));
    TestFactory.git(remotePath, "git", "init", "-q", "--bare");
    TestFactory.git(repoPath, "git", "remote", "add", remoteName, remotePath);
    TestFactory.git(repoPath, "git", "push", "-q", remoteName, "main");
    return remotePath;
  },

  /** Clone a (bare) remote into a fresh working dir with a test identity. */
  cloneRepo(remotePath: string): string {
    const clonePath = mkdtempSync(path.join(tmpdir(), "wick-clone-"));
    TestFactory.git(clonePath, "git", "clone", "-q", remotePath, ".");
    TestFactory.git(clonePath, "git", "config", "user.email", "test@example.com");
    TestFactory.git(clonePath, "git", "config", "user.name", "Test");
    return clonePath;
  },

  // ------------------------------------------------------ note / session ----

  /** A single note session with descriptive defaults, overridable per field. */
  makeSession(overrides: Partial<NoteSession> = {}): NoteSession {
    return {
      id: "session-1",
      provider: "provider-1",
      model: "model-1",
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      ...overrides,
    };
  },

  /** A note payload wrapping the given sessions. */
  makeNote(sessions: NoteSession[]): NoteData {
    return { v: 1, sessions };
  },

  /** A note payload wrapping exactly one session built from overrides. */
  makeSessionNote(overrides: Partial<NoteSession> = {}): NoteData {
    return TestFactory.makeNote([TestFactory.makeSession(overrides)]);
  },

  // -------------------------------------------------------------- providers ----

  /**
   * A mock provider proving provider isolation: its usage flows through
   * attribution → notes → report without any change outside src/providers/.
   * Grow `totals.output` between commits to simulate a session burning tokens.
   */
  makeMockProvider(providerId: string, totals: MutableOutputTotals): UsageProvider {
    return {
      id: providerId,
      async discoverSessions(_repoRoot) {
        return [{ id: "mock-session-1", provider: providerId, path: "/dev/null" }];
      },
      async getUsage(sessionRef): Promise<SessionUsage> {
        return {
          sessionId: sessionRef.id,
          provider: providerId,
          perModel: [
            {
              model: "mock-model-x",
              input: 7,
              cacheRead: 0,
              cacheWrite: 0,
              output: totals.output,
            },
          ],
          firstTs: SESSION_FIRST_TIMESTAMP,
          lastTs: SESSION_LAST_TIMESTAMP,
        };
      },
    };
  },

  /** A single-model SessionUsage as a provider would return it. */
  makeSessionUsage(
    sessionId: string,
    model: string,
    totals: ClaudeUsageTotals,
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
      firstTs: SESSION_FIRST_TIMESTAMP,
      lastTs: SESSION_LAST_TIMESTAMP,
    };
  },

  // -------------------------------------------------- claude code fixtures ----

  /** One assistant transcript line as Claude Code writes it. */
  claudeAssistantLine(
    messageId: string,
    model: string,
    usage: ClaudeUsageTotals,
    timestamp: string = DEFAULT_TIMESTAMP,
  ): string {
    return JSON.stringify({
      type: "assistant",
      uuid: `uuid-${messageId}`,
      timestamp,
      message: {
        id: messageId,
        model,
        usage: {
          input_tokens: usage.input ?? 0,
          cache_read_input_tokens: usage.cacheRead ?? 0,
          cache_creation_input_tokens: usage.cacheWrite ?? 0,
          output_tokens: usage.output ?? 0,
        },
      },
    });
  },

  /**
   * A ~/.claude directory holding one transcript for the given repo/session.
   * Returns the claude directory path for `createClaudeCodeProvider`.
   */
  makeClaudeTranscript(options: {
    repoRoot: string;
    sessionId: string;
    lines: string[];
  }): string {
    const claudeDir = mkdtempSync(path.join(tmpdir(), "wick-claude-"));
    const projectDir = path.join(
      claudeDir,
      "projects",
      encodeProjectPath(options.repoRoot),
    );
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, `${options.sessionId}.jsonl`),
      options.lines.join("\n"),
    );
    return claudeDir;
  },

  // --------------------------------------------------- copilot cli fixtures ----

  /** One Copilot CLI event line (events.jsonl is one JSON event per line). */
  copilotEventLine(type: string, data: unknown, timestamp: string): string {
    return JSON.stringify({ type, data, id: "event", timestamp, parentId: null });
  },

  copilotSessionStartLine(options: {
    sessionId: string;
    gitRoot: string;
    model: string;
    timestamp: string;
  }): string {
    return TestFactory.copilotEventLine(
      "session.start",
      {
        sessionId: options.sessionId,
        producer: "copilot-agent",
        selectedModel: options.model,
        context: {
          cwd: options.gitRoot,
          gitRoot: options.gitRoot,
          branch: "main",
          repository: "acme/repo",
        },
      },
      options.timestamp,
    );
  },

  copilotShutdownLine(options: {
    model: string;
    usage: CopilotShutdownUsage;
    timestamp: string;
  }): string {
    return TestFactory.copilotEventLine(
      "session.shutdown",
      {
        shutdownType: "routine",
        // inputTokens INCLUDES cacheReadTokens — the provider must subtract.
        modelMetrics: { [options.model]: { usage: options.usage } },
      },
      options.timestamp,
    );
  },

  /** Write one Copilot CLI session into an existing ~/.copilot directory. */
  writeCopilotSession(copilotDir: string, options: CopilotSessionOptions): string {
    const sessionId = options.sessionId ?? DEFAULT_COPILOT_SESSION_ID;
    const model = options.model ?? DEFAULT_COPILOT_MODEL;
    const gitRoot = options.gitRoot ?? copilotDir;
    const messageOutputs = options.messageOutputs ?? [100, 50];
    const sessionDir = path.join(copilotDir, "session-state", sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const eventLines = [
      TestFactory.copilotSessionStartLine({
        sessionId,
        gitRoot,
        model,
        timestamp: "2026-07-20T10:00:00.000Z",
      }),
      ...messageOutputs.map((output, index) =>
        TestFactory.copilotEventLine(
          "assistant.message",
          { model, outputTokens: output, messageId: `message-${index + 1}` },
          `2026-07-20T10:${String(10 + index * 10).padStart(2, "0")}:00.000Z`,
        ),
      ),
    ];
    if (options.closed) {
      eventLines.push(
        TestFactory.copilotShutdownLine({
          model,
          usage: options.shutdownUsage ?? DEFAULT_COPILOT_SHUTDOWN_USAGE,
          timestamp: "2026-07-20T10:30:00.000Z",
        }),
      );
    }
    writeFileSync(path.join(sessionDir, "events.jsonl"), eventLines.join("\n") + "\n");
    return sessionDir;
  },

  /**
   * A ~/.copilot directory holding one session, plus a throwaway repo dir the
   * session points at (unless `gitRoot` overrides it). Returns both paths.
   */
  makeCopilotSession(options: CopilotSessionOptions): {
    copilotDir: string;
    repoPath: string;
  } {
    const baseDir = mkdtempSync(path.join(tmpdir(), "wick-copilot-"));
    const repoPath = path.join(baseDir, "repo");
    mkdirSync(repoPath);
    const copilotDir = path.join(baseDir, "copilot");
    TestFactory.writeCopilotSession(copilotDir, {
      ...options,
      gitRoot: options.gitRoot ?? repoPath,
    });
    return { copilotDir, repoPath };
  },

  // ---------------------------------------------------------------- report ----

  /** A minimal Report carrying only a total cost, for renderer/badge tests. */
  makeReport(costUsd: number | null): Report {
    return {
      range: "HEAD",
      commits: [],
      authors: [],
      totals: {
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        costUsd,
        sessions: 0,
        stampedCommits: 0,
        commits: 0,
      },
      unknownModels: [],
    };
  },
};
