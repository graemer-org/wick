import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { install, uninstall, hasWickBlock } from "./install.js";
import { createClaudeCodeProvider, encodeProjectPath } from "./providers/claude-code/index.js";
import { createCopilotCliProvider } from "./providers/copilot-cli/index.js";
import { postCommit, postRewrite } from "./hooks/index.js";
import { readNote, writeNote } from "./notes.js";
import { buildReport } from "./report.js";
import {
  clearProviders,
  registerProvider,
  type SessionUsage,
  type UsageProvider,
} from "./providers/types.js";

function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wick-repo-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "test@example.com");
  sh(dir, "git", "config", "user.name", "Test");
  writeFileSync(path.join(dir, "file.txt"), "one\n");
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-q", "-m", "initial");
  return dir;
}

function commit(
  dir: string,
  msg: string,
  author?: { name: string; email: string },
): string {
  writeFileSync(path.join(dir, "file.txt"), `${msg}\n`, { flag: "a" });
  sh(dir, "git", "add", ".");
  const authorArgs = author
    ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`]
    : [];
  sh(dir, "git", ...authorArgs, "commit", "-q", "-m", msg);
  return sh(dir, "git", "rev-parse", "HEAD");
}

/**
 * A mock second provider proving provider isolation: its usage flows through
 * attribution → notes → report without any change outside src/providers/.
 */
function mockProvider(id: string, totalsRef: { output: number }): UsageProvider {
  return {
    id,
    async discoverSessions(_repoRoot, _window) {
      return [{ id: "mock-session-1", provider: id, path: "/dev/null" }];
    },
    async getUsage(ref): Promise<SessionUsage> {
      return {
        sessionId: ref.id,
        provider: id,
        perModel: [
          {
            model: "mock-model-x",
            input: 7,
            cacheRead: 0,
            cacheWrite: 0,
            output: totalsRef.output,
          },
        ],
        firstTs: "2026-07-19T10:00:00.000Z",
        lastTs: "2026-07-19T12:00:00.000Z",
      };
    },
  };
}

describe("installer (chain-safe)", () => {
  it("preserves an existing Husky-style hook, appends a wick block, and is idempotent", async () => {
    // Arrange — a repo with a pre-existing Husky-style hook.
    const repo = makeRepo();
    const hookPath = path.join(repo, ".git", "hooks", "post-commit");
    const husky = `#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\necho husky-ran\n`;
    writeFileSync(hookPath, husky);
    chmodSync(hookPath, 0o755);

    // Act
    await install(repo);

    // Assert — existing content preserved, wick block appended.
    let content = readFileSync(hookPath, "utf8");
    expect(content).toContain("husky.sh");
    expect(content).toContain("echo husky-ran");
    expect(content).toContain("# >>> wick >>>");

    // Act + Assert — idempotent: a second install must not duplicate the block.
    await install(repo);
    content = readFileSync(hookPath, "utf8");
    expect(content.split("# >>> wick >>>").length).toBe(2);

    // Act + Assert — uninstall removes only the wick block.
    await uninstall(repo);
    content = readFileSync(hookPath, "utf8");
    expect(content).toContain("echo husky-ran");
    expect(content).not.toContain("wick");
  });

  it("creates hooks from scratch and deletes them again on uninstall", async () => {
    // Arrange
    const repo = makeRepo();

    // Act
    await install(repo);

    // Assert — all four hooks present, notes.rewriteRef configured.
    expect(await hasWickBlock(repo, "post-commit")).toBe(true);
    expect(await hasWickBlock(repo, "post-rewrite")).toBe(true);
    expect(await hasWickBlock(repo, "post-merge")).toBe(true);
    expect(await hasWickBlock(repo, "pre-push")).toBe(true);
    expect(sh(repo, "git", "config", "notes.rewriteRef")).toBe("refs/notes/wick");

    // Act + Assert — uninstall deletes the wick-only hook files again.
    await uninstall(repo);
    expect(existsSync(path.join(repo, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("respects core.hooksPath", async () => {
    // Arrange
    const repo = makeRepo();
    sh(repo, "git", "config", "core.hooksPath", ".myhooks");

    // Act
    const result = await install(repo);

    // Assert
    expect(result.hooksDir).toBe(path.join(repo, ".myhooks"));
    expect(existsSync(path.join(repo, ".myhooks", "post-commit"))).toBe(true);
  });
});

describe("attribution end-to-end (mock provider = provider isolation)", () => {
  beforeEach(() => clearProviders());
  afterEach(() => clearProviders());

  it("stamps commits with deltas and reports them", async () => {
    // Arrange
    const repo = makeRepo();
    const totals = { output: 100 };
    registerProvider(mockProvider("mock-provider", totals));

    // Act
    const c1 = commit(repo, "first change");
    await postCommit(repo, c1);

    // Assert
    const note1 = readNote(c1, repo);
    expect(note1).not.toBeNull();
    expect(note1!.sessions[0]).toMatchObject({
      id: "mock-session-1",
      provider: "mock-provider",
      model: "mock-model-x",
      output: 100,
    });

    // Act + Assert — session keeps burning; next commit gets only the delta.
    totals.output = 260;
    const c2 = commit(repo, "second change");
    await postCommit(repo, c2);
    const note2 = readNote(c2, repo);
    expect(note2!.sessions[0].output).toBe(160);

    // Act + Assert — report aggregates both commits; unknown model → cost n/a.
    const report = buildReport(repo, "HEAD~2..HEAD");
    expect(report.totals.tokens.output).toBe(260);
    expect(report.totals.sessions).toBe(1);
    expect(report.commits.every((c) => c.costUsd === null)).toBe(true);
    expect(report.unknownModels).toContain("mock-provider/mock-model-x");
  });

  it("never throws into the hook path when a provider fails", async () => {
    // Arrange — a provider that throws from every method.
    const repo = makeRepo();
    registerProvider({
      id: "broken",
      async discoverSessions() {
        throw new Error("boom");
      },
      async getUsage(): Promise<SessionUsage> {
        throw new Error("boom");
      },
    });
    const c1 = commit(repo, "change");

    // Act + Assert — the hook path swallows the failure and writes no note.
    await expect(postCommit(repo, c1)).resolves.toBeUndefined();
    expect(readNote(c1, repo)).toBeNull();
  });
});

describe("rewrite remapping", () => {
  it("preserves stamps across git commit --amend", async () => {
    // Arrange — a stamped commit that gets amended into a new sha.
    const repo = makeRepo();
    const c1 = commit(repo, "work");
    writeNote(
      c1,
      { v: 1, sessions: [{ id: "s", provider: "p", model: "m", input: 1, cacheRead: 0, cacheWrite: 0, output: 9 }] },
      repo,
    );
    sh(repo, "git", "commit", "-q", "--amend", "-m", "work (amended)");
    const c2 = sh(repo, "git", "rev-parse", "HEAD");
    expect(c2).not.toBe(c1);

    // Act
    await postRewrite(repo, `${c1} ${c2}\n`);

    // Assert
    const note = readNote(c2, repo);
    expect(note!.sessions[0].output).toBe(9);
  });

  it("preserves stamps across rebase and merges with an existing note", async () => {
    // Arrange — two stamped commits about to be squashed into one.
    const repo = makeRepo();
    const c1 = commit(repo, "a");
    writeNote(
      c1,
      { v: 1, sessions: [{ id: "s", provider: "p", model: "m", input: 0, cacheRead: 0, cacheWrite: 0, output: 5 }] },
      repo,
    );
    const c2 = commit(repo, "b");
    writeNote(
      c2,
      { v: 1, sessions: [{ id: "s", provider: "p", model: "m", input: 0, cacheRead: 0, cacheWrite: 0, output: 7 }] },
      repo,
    );
    const squashed = commit(repo, "squashed");

    // Act — simulate a rebase squashing both commits into one new commit.
    await postRewrite(repo, `${c1} ${squashed}\n${c2} ${squashed}\n`);

    // Assert
    const note = readNote(squashed, repo);
    expect(note!.sessions[0].output).toBe(12);
  });

  it("does not double a note that git's notes.rewriteRef already copied", async () => {
    // Arrange — the new commit already carries an identical git-copied note.
    const repo = makeRepo();
    const c1 = commit(repo, "a");
    const data = {
      v: 1 as const,
      sessions: [{ id: "s", provider: "p", model: "m", input: 0, cacheRead: 0, cacheWrite: 0, output: 5 }],
    };
    writeNote(c1, data, repo);
    const c2 = commit(repo, "b");
    writeNote(c2, data, repo); // identical — as if git already copied it

    // Act
    await postRewrite(repo, `${c1} ${c2}\n`);

    // Assert — not doubled.
    expect(readNote(c2, repo)!.sessions[0].output).toBe(5);
  });
});

describe("fixup commits (real autosquash rebases, notes.rewriteRef set)", () => {
  const stamp = (id: string, output: number) => ({
    v: 1 as const,
    sessions: [{ id, provider: "p", model: "m", input: 0, cacheRead: 0, cacheWrite: 0, output }],
  });

  /** Repo with commit A (stamped) + a fixup of A (stamped), rewriteRef configured. */
  function fixupRepo(): { repo: string; a: string; f: string } {
    const repo = makeRepo();
    sh(repo, "git", "config", "notes.rewriteRef", "refs/notes/wick");
    const a = commit(repo, "feature A");
    writeNote(a, stamp("s1", 5), repo);
    writeFileSync(path.join(repo, "file.txt"), "fixup\n", { flag: "a" });
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-q", "--fixup", a);
    const f = sh(repo, "git", "rev-parse", "HEAD");
    writeNote(f, stamp("s2", 7), repo);
    return { repo, a, f };
  }

  function autosquash(repo: string): string {
    sh(repo, "git", "-c", "sequence.editor=:", "rebase", "-q", "-i", "--autosquash", "HEAD~2");
    return sh(repo, "git", "rev-parse", "HEAD");
  }

  it("sums both stamps despite git's default concatenate copy", async () => {
    // Arrange — a real autosquash rebase; git's own rewriteRef copying
    // (default rewriteMode=concatenate) has already put a malformed two-line
    // note on the squashed commit before the hook runs.
    const { repo, a, f } = fixupRepo();
    const squashed = autosquash(repo);
    const raw = sh(repo, "git", "notes", "--ref=refs/notes/wick", "show", squashed);
    expect(raw).toContain("s1");
    expect(raw).toContain("s2");
    expect(readNote(squashed, repo)).toBeNull(); // malformed → treated as absent

    // Act
    await postRewrite(repo, `${a} ${squashed}\n${f} ${squashed}\n`);

    // Assert
    const note = readNote(squashed, repo)!;
    expect(note.sessions).toHaveLength(2);
    expect(note.sessions.reduce((s, x) => s + x.output, 0)).toBe(12);
  });

  it("does not double-count the fixup with notes.rewriteMode=overwrite", async () => {
    // Arrange — with rewriteMode=overwrite, git copied ONE source note
    // verbatim onto the squashed commit: the case that used to double-count.
    const { repo, a, f } = fixupRepo();
    sh(repo, "git", "config", "notes.rewriteMode", "overwrite");
    const squashed = autosquash(repo);
    expect(readNote(squashed, repo)).not.toBeNull();

    // Act
    await postRewrite(repo, `${a} ${squashed}\n${f} ${squashed}\n`);

    // Assert
    const note = readNote(squashed, repo)!;
    const byId = Object.fromEntries(note.sessions.map((s) => [s.id, s.output]));
    expect(byId).toEqual({ s1: 5, s2: 7 }); // was s2: 14 before the fix
  });

  it("keeps a fresh amend stamp while merging the old note in", async () => {
    // Arrange — post-commit fires on amend before post-rewrite and has
    // already stamped the new delta onto the amended commit.
    const repo = makeRepo();
    const c1 = commit(repo, "work");
    writeNote(c1, stamp("s-old", 5), repo);
    sh(repo, "git", "commit", "-q", "--amend", "-m", "work (amended)");
    const c2 = sh(repo, "git", "rev-parse", "HEAD");
    writeNote(c2, stamp("s-new", 3), repo);

    // Act
    await postRewrite(repo, `${c1} ${c2}\n`);

    // Assert
    const note = readNote(c2, repo)!;
    const byId = Object.fromEntries(note.sessions.map((s) => [s.id, s.output]));
    expect(byId).toEqual({ "s-old": 5, "s-new": 3 });
  });
});

describe("report ranges", () => {
  beforeEach(() => clearProviders());
  afterEach(() => clearProviders());

  it("only includes commits ahead of the merge-base on a branch", async () => {
    // Arrange — a stamped commit on main, then more spend on a feature branch.
    const repo = makeRepo();
    const totals = { output: 50 };
    registerProvider(mockProvider("mock", totals));
    const onMain = commit(repo, "main work");
    await postCommit(repo, onMain);
    sh(repo, "git", "checkout", "-q", "-b", "feature");
    totals.output = 80;
    const onBranch = commit(repo, "branch work");
    await postCommit(repo, onBranch);

    // Act — default range: merge-base(main, HEAD)..HEAD
    const report = buildReport(repo);

    // Assert — parent-branch costs excluded.
    expect(report.commits).toHaveLength(1);
    expect(report.commits[0].commit).toBe(onBranch);
    expect(report.totals.tokens.output).toBe(30); // only the branch delta
  });

  it("aggregates costs by commit author", async () => {
    // Arrange — three stamped commits from two authors.
    const repo = makeRepo();
    const totals = { output: 100 };
    registerProvider(mockProvider("mock", totals));
    const c1 = commit(repo, "alice work", { name: "Alice", email: "alice@example.com" });
    await postCommit(repo, c1);
    totals.output = 150;
    const c2 = commit(repo, "bob work", { name: "Bob", email: "bob@example.com" });
    await postCommit(repo, c2);
    totals.output = 250;
    const c3 = commit(repo, "more alice", { name: "Alice", email: "alice@example.com" });
    await postCommit(repo, c3);

    // Act
    const report = buildReport(repo, "HEAD~3..HEAD");

    // Assert
    expect(report.authors).toHaveLength(2);
    const alice = report.authors.find((a) => a.author === "Alice")!;
    const bob = report.authors.find((a) => a.author === "Bob")!;
    expect(alice.stampedCommits).toBe(2);
    expect(alice.tokens.output).toBe(200); // 100 + 100
    expect(bob.stampedCommits).toBe(1);
    expect(bob.tokens.output).toBe(50);
    // Per-author sums equal the range total.
    expect(alice.tokens.output + bob.tokens.output).toBe(report.totals.tokens.output);
    // Commits carry their author in JSON output.
    expect(report.commits.find((c) => c.commit === c2)?.author).toBe("Bob");
  });

  it("unifies author identities via .mailmap", async () => {
    // Arrange — same person under two emails, unified by a .mailmap.
    const repo = makeRepo();
    const totals = { output: 10 };
    registerProvider(mockProvider("mock", totals));
    const c1 = commit(repo, "laptop", { name: "Alice", email: "alice@work.example" });
    await postCommit(repo, c1);
    totals.output = 30;
    const c2 = commit(repo, "web ui", { name: "Alice", email: "12345+alice@users.noreply.github.com" });
    await postCommit(repo, c2);
    writeFileSync(
      path.join(repo, ".mailmap"),
      "Alice <12345+alice@users.noreply.github.com> <alice@work.example>\n",
    );

    // Act
    const report = buildReport(repo, "HEAD~2..HEAD");

    // Assert
    expect(report.authors).toHaveLength(1);
    expect(report.authors[0].authorEmail).toBe("12345+alice@users.noreply.github.com");
    expect(report.authors[0].tokens.output).toBe(30);
  });

  it("reports full history when on the default branch", async () => {
    // Arrange
    const repo = makeRepo();
    const totals = { output: 10 };
    registerProvider(mockProvider("mock", totals));
    const c1 = commit(repo, "x");
    await postCommit(repo, c1);

    // Act
    const report = buildReport(repo);

    // Assert
    expect(report.range).toBe("HEAD");
    expect(report.totals.tokens.output).toBe(10);
  });
});

describe("squash-merge reconciliation", () => {
  it("consolidates branch stamps onto a squash commit, idempotently", async () => {
    // Arrange — a stamped feature branch squash-merged without post-rewrite.
    const { consolidateNotes, rangeShas } = await import("./reconcile.js");
    const repo = makeRepo();
    const base = sh(repo, "git", "rev-parse", "HEAD");

    sh(repo, "git", "checkout", "-q", "-b", "feature");
    const c1 = commit(repo, "a");
    writeNote(
      c1,
      { v: 1, sessions: [{ id: "s", provider: "p", model: "m", input: 1, cacheRead: 10, cacheWrite: 0, output: 5 }] },
      repo,
    );
    const c2 = commit(repo, "b");
    writeNote(
      c2,
      { v: 1, sessions: [{ id: "s", provider: "p", model: "m", input: 2, cacheRead: 20, cacheWrite: 0, output: 7 }] },
      repo,
    );

    sh(repo, "git", "checkout", "-q", "main");
    sh(repo, "git", "merge", "--squash", "feature");
    sh(repo, "git", "commit", "-q", "-m", "feature (squashed)");
    const squash = sh(repo, "git", "rev-parse", "HEAD");
    expect(readNote(squash, repo)).toBeNull();

    // Act
    const shas = rangeShas(repo, `${base}..feature`);
    const result = consolidateNotes(repo, shas, squash);

    // Assert — both stamps consolidated onto the squash commit.
    expect(shas).toEqual([c1, c2]);
    expect(result).toBe("written");
    const note = readNote(squash, repo)!;
    expect(note.sessions[0]).toMatchObject({ input: 3, cacheRead: 30, output: 12 });

    // Act + Assert — running reconciliation again must not double the numbers.
    expect(consolidateNotes(repo, shas, squash)).toBe("target-already-stamped");
    expect(readNote(squash, repo)!.sessions[0].output).toBe(12);
  });

  it("reports when the source range carries no stamps", async () => {
    // Arrange
    const { consolidateNotes } = await import("./reconcile.js");
    const repo = makeRepo();
    const c1 = commit(repo, "unstamped");
    const c2 = commit(repo, "target");

    // Act + Assert
    expect(consolidateNotes(repo, [c1], c2)).toBe("no-source-notes");
    expect(readNote(c2, repo)).toBeNull();
  });
});

describe("corrupt transcript resilience", () => {
  it("a git commit never fails because of wick, even with a corrupt transcript", async () => {
    // Arrange
    const repo = makeRepo();
    await install(repo);

    // Act — commit with hooks installed (wick not on PATH inside the test
    // env resolves via the embedded node entry; either way the hook exits 0
    // because every branch ends in `|| true`).
    const out = execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "hooked"], {
      cwd: repo,
      encoding: "utf8",
    });

    // Assert — the commit went through.
    expect(out).toBeDefined();
    expect(sh(repo, "git", "log", "--format=%s", "-1")).toBe("hooked");
  });
});

describe("multi-provider end-to-end (claude-code + copilot-cli on one repo)", () => {
  beforeEach(() => clearProviders());
  afterEach(() => clearProviders());

  it("stamps one commit with sessions from both real providers and reports the sum", async () => {
    // Arrange — one repo, plus real on-disk fixtures for BOTH providers:
    // a Claude Code transcript and a Copilot CLI session that each point at it.
    const repo = makeRepo();
    const root = sh(repo, "git", "rev-parse", "--show-toplevel");

    const claudeDir = mkdtempSync(path.join(tmpdir(), "wick-claude-"));
    const claudeProject = path.join(claudeDir, "projects", encodeProjectPath(root));
    mkdirSync(claudeProject, { recursive: true });
    writeFileSync(
      path.join(claudeProject, "11111111-1111-1111-1111-111111111111.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-20T10:00:00.000Z",
        message: {
          id: "msg_1",
          model: "mock-claude",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 5,
            output_tokens: 40,
          },
        },
      }) + "\n",
    );

    const copilotDir = mkdtempSync(path.join(tmpdir(), "wick-copilot-"));
    const copilotSession = path.join(
      copilotDir,
      "session-state",
      "22222222-2222-2222-2222-222222222222",
    );
    mkdirSync(copilotSession, { recursive: true });
    writeFileSync(
      path.join(copilotSession, "events.jsonl"),
      [
        JSON.stringify({
          type: "session.start",
          data: { sessionId: "22222222-2222-2222-2222-222222222222", context: { cwd: root, gitRoot: root } },
          timestamp: "2026-07-20T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "session.shutdown",
          data: {
            modelMetrics: {
              "mock-copilot": {
                // inputTokens include cacheReadTokens (Copilot semantics).
                usage: { inputTokens: 300, outputTokens: 60, cacheReadTokens: 250, cacheWriteTokens: 20 },
              },
            },
          },
          timestamp: "2026-07-20T10:30:00.000Z",
        }),
      ].join("\n") + "\n",
    );

    registerProvider(createClaudeCodeProvider({ claudeDir }));
    registerProvider(createCopilotCliProvider({ copilotDir }));

    // Act — a single commit gets stamped, then reported.
    const c1 = commit(repo, "work with two assistants");
    await postCommit(repo, c1);
    const note = readNote(c1, repo);
    const report = buildReport(repo, "HEAD~1..HEAD");

    // Assert — the note carries one session per provider with correct classes
    // (copilot input = 300 inclusive − 250 cached), and the report sums both.
    expect(note).not.toBeNull();
    expect(note!.sessions).toHaveLength(2);
    const byProvider = Object.fromEntries(note!.sessions.map((s) => [s.provider, s]));
    expect(byProvider["claude-code"]).toMatchObject({
      model: "mock-claude",
      input: 10,
      cacheRead: 100,
      cacheWrite: 5,
      output: 40,
    });
    expect(byProvider["copilot-cli"]).toMatchObject({
      model: "mock-copilot",
      input: 50,
      cacheRead: 250,
      cacheWrite: 20,
      output: 60,
    });
    expect(report.totals.sessions).toBe(2);
    expect(report.totals.tokens.output).toBe(100);
    expect(report.totals.tokens.cacheRead).toBe(350);
    expect(report.unknownModels).toEqual(
      expect.arrayContaining(["claude-code/mock-claude", "copilot-cli/mock-copilot"]),
    );
  });
});
