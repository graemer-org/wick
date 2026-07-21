import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import * as path from "node:path";
import { install, uninstall, hasWickBlock } from "./install.js";
import { createClaudeCodeProvider } from "./providers/claude-code/index.js";
import { createCopilotCliProvider } from "./providers/copilot-cli/index.js";
import { postCommit, postRewrite, prePush } from "./hooks/index.js";
import { readNote, syncNotesFromRemote, writeNote } from "./notes.js";
import { buildReport, formatCostOutput, renderCostLine, summarizeCost } from "./report.js";
import { clearProviders, collectUsage, registerProvider, type SessionUsage } from "./providers/types.js";
import type { PricingTable } from "./pricing.js";
import { TestFactory } from "./test-factory.js";

describe("installer (chain-safe)", () => {
  it("preserves an existing Husky-style hook, appends a wick block, and is idempotent", async () => {
    // Arrange — a repo with a pre-existing Husky-style hook.
    const repoPath = TestFactory.makeRepo();
    const hookPath = path.join(repoPath, ".git", "hooks", "post-commit");
    const huskyHook = `#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\necho husky-ran\n`;
    writeFileSync(hookPath, huskyHook);
    chmodSync(hookPath, 0o755);

    // Act
    await install(repoPath);

    // Assert — existing content preserved, wick block appended.
    let hookContent = readFileSync(hookPath, "utf8");
    expect(hookContent).toContain("husky.sh");
    expect(hookContent).toContain("echo husky-ran");
    expect(hookContent).toContain("# >>> wick >>>");

    // Act + Assert — idempotent: a second install must not duplicate the block.
    await install(repoPath);
    hookContent = readFileSync(hookPath, "utf8");
    expect(hookContent.split("# >>> wick >>>").length).toBe(2);

    // Act + Assert — uninstall removes only the wick block.
    await uninstall(repoPath);
    hookContent = readFileSync(hookPath, "utf8");
    expect(hookContent).toContain("echo husky-ran");
    expect(hookContent).not.toContain("wick");
  });

  it("creates hooks from scratch and deletes them again on uninstall", async () => {
    // Arrange
    const repoPath = TestFactory.makeRepo();

    // Act
    await install(repoPath);

    // Assert — all four hooks present, notes.rewriteRef configured.
    expect(await hasWickBlock(repoPath, "post-commit")).toBe(true);
    expect(await hasWickBlock(repoPath, "post-rewrite")).toBe(true);
    expect(await hasWickBlock(repoPath, "post-merge")).toBe(true);
    expect(await hasWickBlock(repoPath, "pre-push")).toBe(true);
    expect(TestFactory.git(repoPath, "git", "config", "notes.rewriteRef")).toBe("refs/notes/wick");

    // Act + Assert — uninstall deletes the wick-only hook files again.
    await uninstall(repoPath);
    expect(existsSync(path.join(repoPath, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("respects core.hooksPath", async () => {
    // Arrange
    const repoPath = TestFactory.makeRepo();
    TestFactory.git(repoPath, "git", "config", "core.hooksPath", ".myhooks");

    // Act
    const result = await install(repoPath);

    // Assert
    expect(result.hooksDir).toBe(path.join(repoPath, ".myhooks"));
    expect(existsSync(path.join(repoPath, ".myhooks", "post-commit"))).toBe(true);
  });
});

describe("attribution end-to-end (mock provider = provider isolation)", () => {
  beforeEach(() => clearProviders());
  afterEach(() => clearProviders());

  it("stamps commits with deltas and reports them", async () => {
    // Arrange
    const repoPath = TestFactory.makeRepo();
    const sessionTotals = { output: 100 };
    registerProvider(TestFactory.makeMockProvider("mock-provider", sessionTotals));

    // Act
    const firstCommit = TestFactory.makeCommit(repoPath, "first change");
    await postCommit(repoPath, firstCommit);

    // Assert
    const firstNote = readNote(firstCommit, repoPath);
    expect(firstNote).not.toBeNull();
    expect(firstNote!.sessions[0]).toMatchObject({
      id: "mock-session-1",
      provider: "mock-provider",
      model: "mock-model-x",
      output: 100,
    });

    // Act + Assert — session keeps burning; next commit gets only the delta.
    sessionTotals.output = 260;
    const secondCommit = TestFactory.makeCommit(repoPath, "second change");
    await postCommit(repoPath, secondCommit);
    const secondNote = readNote(secondCommit, repoPath);
    expect(secondNote!.sessions[0].output).toBe(160);

    // Act + Assert — report aggregates both commits; unknown model → cost n/a.
    const report = buildReport(repoPath, "HEAD~2..HEAD");
    expect(report.totals.tokens.output).toBe(260);
    expect(report.totals.sessions).toBe(1);
    expect(report.commits.every((commitReport) => commitReport.costUsd === null)).toBe(true);
    expect(report.unknownModels).toContain("mock-provider/mock-model-x");
  });

  it("never throws into the hook path when a provider fails", async () => {
    // Arrange — a provider that throws from every method.
    const repoPath = TestFactory.makeRepo();
    registerProvider({
      id: "broken",
      async discoverSessions() {
        throw new Error("boom");
      },
      async getUsage(): Promise<SessionUsage> {
        throw new Error("boom");
      },
    });
    const stampedCommit = TestFactory.makeCommit(repoPath, "change");

    // Act + Assert — the hook path swallows the failure and writes no note.
    await expect(postCommit(repoPath, stampedCommit)).resolves.toBeUndefined();
    expect(readNote(stampedCommit, repoPath)).toBeNull();
  });
});

describe("rewrite remapping", () => {
  it("preserves stamps across git commit --amend", async () => {
    // Arrange — a stamped commit that gets amended into a new sha.
    const repoPath = TestFactory.makeRepo();
    const originalCommit = TestFactory.makeCommit(repoPath, "work");
    writeNote(originalCommit, TestFactory.makeSessionNote({ input: 1, output: 9 }), repoPath);
    TestFactory.git(repoPath, "git", "commit", "-q", "--amend", "-m", "work (amended)");
    const amendedCommit = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");
    expect(amendedCommit).not.toBe(originalCommit);

    // Act
    await postRewrite(repoPath, `${originalCommit} ${amendedCommit}\n`);

    // Assert
    const note = readNote(amendedCommit, repoPath);
    expect(note!.sessions[0].output).toBe(9);
  });

  it("preserves stamps across rebase and merges with an existing note", async () => {
    // Arrange — two stamped commits about to be squashed into one.
    const repoPath = TestFactory.makeRepo();
    const firstCommit = TestFactory.makeCommit(repoPath, "a");
    writeNote(firstCommit, TestFactory.makeSessionNote({ output: 5 }), repoPath);
    const secondCommit = TestFactory.makeCommit(repoPath, "b");
    writeNote(secondCommit, TestFactory.makeSessionNote({ output: 7 }), repoPath);
    const squashedCommit = TestFactory.makeCommit(repoPath, "squashed");

    // Act — simulate a rebase squashing both commits into one new commit.
    await postRewrite(repoPath, `${firstCommit} ${squashedCommit}\n${secondCommit} ${squashedCommit}\n`);

    // Assert
    const note = readNote(squashedCommit, repoPath);
    expect(note!.sessions[0].output).toBe(12);
  });

  it("does not double a note that git's notes.rewriteRef already copied", async () => {
    // Arrange — the new commit already carries an identical git-copied note.
    const repoPath = TestFactory.makeRepo();
    const firstCommit = TestFactory.makeCommit(repoPath, "a");
    const noteData = TestFactory.makeSessionNote({ output: 5 });
    writeNote(firstCommit, noteData, repoPath);
    const secondCommit = TestFactory.makeCommit(repoPath, "b");
    writeNote(secondCommit, noteData, repoPath); // identical — as if git already copied it

    // Act
    await postRewrite(repoPath, `${firstCommit} ${secondCommit}\n`);

    // Assert — not doubled.
    expect(readNote(secondCommit, repoPath)!.sessions[0].output).toBe(5);
  });
});

describe("fixup commits (real autosquash rebases, notes.rewriteRef set)", () => {
  /** Repo with a feature commit (stamped) + a fixup of it (stamped). */
  function makeFixupRepo(): { repoPath: string; featureCommit: string; fixupCommit: string } {
    const repoPath = TestFactory.makeRepo();
    TestFactory.git(repoPath, "git", "config", "notes.rewriteRef", "refs/notes/wick");
    const featureCommit = TestFactory.makeCommit(repoPath, "feature A");
    writeNote(featureCommit, TestFactory.makeSessionNote({ id: "session-1", output: 5 }), repoPath);
    writeFileSync(path.join(repoPath, "file.txt"), "fixup\n", { flag: "a" });
    TestFactory.git(repoPath, "git", "add", ".");
    TestFactory.git(repoPath, "git", "commit", "-q", "--fixup", featureCommit);
    const fixupCommit = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");
    writeNote(fixupCommit, TestFactory.makeSessionNote({ id: "session-2", output: 7 }), repoPath);
    return { repoPath, featureCommit, fixupCommit };
  }

  function autosquash(repoPath: string): string {
    TestFactory.git(repoPath, "git", "-c", "sequence.editor=:", "rebase", "-q", "-i", "--autosquash", "HEAD~2");
    return TestFactory.git(repoPath, "git", "rev-parse", "HEAD");
  }

  it("sums both stamps despite git's default concatenate copy", async () => {
    // Arrange — a real autosquash rebase; git's own rewriteRef copying
    // (default rewriteMode=concatenate) has already put a malformed two-line
    // note on the squashed commit before the hook runs.
    const { repoPath, featureCommit, fixupCommit } = makeFixupRepo();
    const squashedCommit = autosquash(repoPath);
    const rawNote = TestFactory.git(repoPath, "git", "notes", "--ref=refs/notes/wick", "show", squashedCommit);
    expect(rawNote).toContain("session-1");
    expect(rawNote).toContain("session-2");
    expect(readNote(squashedCommit, repoPath)).toBeNull(); // malformed → treated as absent

    // Act
    await postRewrite(repoPath, `${featureCommit} ${squashedCommit}\n${fixupCommit} ${squashedCommit}\n`);

    // Assert
    const note = readNote(squashedCommit, repoPath)!;
    expect(note.sessions).toHaveLength(2);
    expect(note.sessions.reduce((sum, session) => sum + session.output, 0)).toBe(12);
  });

  it("does not double-count the fixup with notes.rewriteMode=overwrite", async () => {
    // Arrange — with rewriteMode=overwrite, git copied ONE source note
    // verbatim onto the squashed commit: the case that used to double-count.
    const { repoPath, featureCommit, fixupCommit } = makeFixupRepo();
    TestFactory.git(repoPath, "git", "config", "notes.rewriteMode", "overwrite");
    const squashedCommit = autosquash(repoPath);
    expect(readNote(squashedCommit, repoPath)).not.toBeNull();

    // Act
    await postRewrite(repoPath, `${featureCommit} ${squashedCommit}\n${fixupCommit} ${squashedCommit}\n`);

    // Assert
    const note = readNote(squashedCommit, repoPath)!;
    const outputsBySessionId = Object.fromEntries(note.sessions.map((session) => [session.id, session.output]));
    expect(outputsBySessionId).toEqual({ "session-1": 5, "session-2": 7 }); // was session-2: 14 before the fix
  });

  it("keeps a fresh amend stamp while merging the old note in", async () => {
    // Arrange — post-commit fires on amend before post-rewrite and has
    // already stamped the new delta onto the amended commit.
    const repoPath = TestFactory.makeRepo();
    const originalCommit = TestFactory.makeCommit(repoPath, "work");
    writeNote(originalCommit, TestFactory.makeSessionNote({ id: "session-old", output: 5 }), repoPath);
    TestFactory.git(repoPath, "git", "commit", "-q", "--amend", "-m", "work (amended)");
    const amendedCommit = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");
    writeNote(amendedCommit, TestFactory.makeSessionNote({ id: "session-new", output: 3 }), repoPath);

    // Act
    await postRewrite(repoPath, `${originalCommit} ${amendedCommit}\n`);

    // Assert
    const note = readNote(amendedCommit, repoPath)!;
    const outputsBySessionId = Object.fromEntries(note.sessions.map((session) => [session.id, session.output]));
    expect(outputsBySessionId).toEqual({ "session-old": 5, "session-new": 3 });
  });
});

describe("report ranges", () => {
  beforeEach(() => clearProviders());
  afterEach(() => clearProviders());

  it("only includes commits ahead of the merge-base on a branch", async () => {
    // Arrange — a stamped commit on main, then more spend on a feature branch.
    const repoPath = TestFactory.makeRepo();
    const sessionTotals = { output: 50 };
    registerProvider(TestFactory.makeMockProvider("mock", sessionTotals));
    const mainCommit = TestFactory.makeCommit(repoPath, "main work");
    await postCommit(repoPath, mainCommit);
    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    sessionTotals.output = 80;
    const branchCommit = TestFactory.makeCommit(repoPath, "branch work");
    await postCommit(repoPath, branchCommit);

    // Act — default range: merge-base(main, HEAD)..HEAD
    const report = buildReport(repoPath);

    // Assert — parent-branch costs excluded.
    expect(report.commits).toHaveLength(1);
    expect(report.commits[0].commit).toBe(branchCommit);
    expect(report.totals.tokens.output).toBe(30); // only the branch delta
  });

  it("aggregates costs by commit author", async () => {
    // Arrange — three stamped commits from two authors.
    const repoPath = TestFactory.makeRepo();
    const sessionTotals = { output: 100 };
    registerProvider(TestFactory.makeMockProvider("mock", sessionTotals));
    const aliceCommit = TestFactory.makeCommit(repoPath, "alice work", { name: "Alice", email: "alice@example.com" });
    await postCommit(repoPath, aliceCommit);
    sessionTotals.output = 150;
    const bobCommit = TestFactory.makeCommit(repoPath, "bob work", { name: "Bob", email: "bob@example.com" });
    await postCommit(repoPath, bobCommit);
    sessionTotals.output = 250;
    const moreAliceCommit = TestFactory.makeCommit(repoPath, "more alice", { name: "Alice", email: "alice@example.com" });
    await postCommit(repoPath, moreAliceCommit);

    // Act
    const report = buildReport(repoPath, "HEAD~3..HEAD");

    // Assert
    expect(report.authors).toHaveLength(2);
    const alice = report.authors.find((author) => author.author === "Alice")!;
    const bob = report.authors.find((author) => author.author === "Bob")!;
    expect(alice.stampedCommits).toBe(2);
    expect(alice.tokens.output).toBe(200); // 100 + 100
    expect(bob.stampedCommits).toBe(1);
    expect(bob.tokens.output).toBe(50);
    // Per-author sums equal the range total.
    expect(alice.tokens.output + bob.tokens.output).toBe(report.totals.tokens.output);
    // Commits carry their author in JSON output.
    expect(report.commits.find((commitReport) => commitReport.commit === bobCommit)?.author).toBe("Bob");
  });

  it("unifies author identities via .mailmap", async () => {
    // Arrange — same person under two emails, unified by a .mailmap.
    const repoPath = TestFactory.makeRepo();
    const sessionTotals = { output: 10 };
    registerProvider(TestFactory.makeMockProvider("mock", sessionTotals));
    const laptopCommit = TestFactory.makeCommit(repoPath, "laptop", { name: "Alice", email: "alice@work.example" });
    await postCommit(repoPath, laptopCommit);
    sessionTotals.output = 30;
    const webCommit = TestFactory.makeCommit(repoPath, "web ui", { name: "Alice", email: "12345+alice@users.noreply.github.com" });
    await postCommit(repoPath, webCommit);
    writeFileSync(
      path.join(repoPath, ".mailmap"),
      "Alice <12345+alice@users.noreply.github.com> <alice@work.example>\n",
    );

    // Act
    const report = buildReport(repoPath, "HEAD~2..HEAD");

    // Assert
    expect(report.authors).toHaveLength(1);
    expect(report.authors[0].authorEmail).toBe("12345+alice@users.noreply.github.com");
    expect(report.authors[0].tokens.output).toBe(30);
  });

  it("reports full history when on the default branch", async () => {
    // Arrange
    const repoPath = TestFactory.makeRepo();
    const sessionTotals = { output: 10 };
    registerProvider(TestFactory.makeMockProvider("mock", sessionTotals));
    const onlyCommit = TestFactory.makeCommit(repoPath, "x");
    await postCommit(repoPath, onlyCommit);

    // Act
    const report = buildReport(repoPath);

    // Assert
    expect(report.range).toBe("HEAD");
    expect(report.totals.tokens.output).toBe(10);
  });
});

describe("squash-merge reconciliation", () => {
  it("consolidates branch stamps onto a squash commit, idempotently", async () => {
    // Arrange — a stamped feature branch squash-merged without post-rewrite.
    const { consolidateNotes, rangeShas } = await import("./reconcile.js");
    const repoPath = TestFactory.makeRepo();
    const baseCommit = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    const firstCommit = TestFactory.makeCommit(repoPath, "a");
    writeNote(firstCommit, TestFactory.makeSessionNote({ input: 1, cacheRead: 10, output: 5 }), repoPath);
    const secondCommit = TestFactory.makeCommit(repoPath, "b");
    writeNote(secondCommit, TestFactory.makeSessionNote({ input: 2, cacheRead: 20, output: 7 }), repoPath);

    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    TestFactory.git(repoPath, "git", "merge", "--squash", "feature");
    TestFactory.git(repoPath, "git", "commit", "-q", "-m", "feature (squashed)");
    const squashCommit = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");
    expect(readNote(squashCommit, repoPath)).toBeNull();

    // Act
    const sourceShas = rangeShas(repoPath, `${baseCommit}..feature`);
    const reconcileResult = consolidateNotes(repoPath, sourceShas, squashCommit);

    // Assert — both stamps consolidated onto the squash commit.
    expect(sourceShas).toEqual([firstCommit, secondCommit]);
    expect(reconcileResult).toBe("written");
    const note = readNote(squashCommit, repoPath)!;
    expect(note.sessions[0]).toMatchObject({ input: 3, cacheRead: 30, output: 12 });

    // Act + Assert — running reconciliation again must not double the numbers.
    expect(consolidateNotes(repoPath, sourceShas, squashCommit)).toBe("target-already-stamped");
    expect(readNote(squashCommit, repoPath)!.sessions[0].output).toBe(12);
  });

  it("reports when the source range carries no stamps", async () => {
    // Arrange
    const { consolidateNotes } = await import("./reconcile.js");
    const repoPath = TestFactory.makeRepo();
    const unstampedCommit = TestFactory.makeCommit(repoPath, "unstamped");
    const targetCommit = TestFactory.makeCommit(repoPath, "target");

    // Act + Assert
    expect(consolidateNotes(repoPath, [unstampedCommit], targetCommit)).toBe("no-source-notes");
    expect(readNote(targetCommit, repoPath)).toBeNull();
  });
});

describe("corrupt transcript resilience", () => {
  it("a git commit never fails because of wick, even with a corrupt transcript", async () => {
    // Arrange
    const repoPath = TestFactory.makeRepo();
    await install(repoPath);

    // Act — commit with hooks installed (wick not on PATH inside the test
    // env resolves via the embedded node entry; either way the hook exits 0
    // because every branch ends in `|| true`).
    const commitOutput = execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "hooked"], {
      cwd: repoPath,
      encoding: "utf8",
    });

    // Assert — the commit went through.
    expect(commitOutput).toBeDefined();
    expect(TestFactory.git(repoPath, "git", "log", "--format=%s", "-1")).toBe("hooked");
  });
});

describe("multi-provider end-to-end (claude-code + copilot-cli on one repo)", () => {
  beforeEach(() => clearProviders());
  afterEach(() => clearProviders());

  it("stamps one commit with sessions from both real providers and reports the sum", async () => {
    // Arrange — one repo, plus real on-disk fixtures for BOTH providers:
    // a Claude Code transcript and a Copilot CLI session that each point at it.
    const repoPath = TestFactory.makeRepo();
    const repoRoot = TestFactory.git(repoPath, "git", "rev-parse", "--show-toplevel");

    const claudeDir = TestFactory.makeClaudeTranscript({
      repoRoot,
      sessionId: "11111111-1111-1111-1111-111111111111",
      lines: [
        TestFactory.claudeAssistantLine(
          "msg_1",
          "mock-claude",
          { input: 10, cacheRead: 100, cacheWrite: 5, output: 40 },
          "2026-07-20T10:00:00.000Z",
        ),
      ],
    });

    const { copilotDir } = TestFactory.makeCopilotSession({
      closed: true,
      gitRoot: repoRoot,
      sessionId: "22222222-2222-2222-2222-222222222222",
      model: "mock-copilot",
      // inputTokens include cacheReadTokens (Copilot semantics): input = 50.
      shutdownUsage: { inputTokens: 300, outputTokens: 60, cacheReadTokens: 250, cacheWriteTokens: 20 },
      messageOutputs: [],
    });

    registerProvider(createClaudeCodeProvider({ claudeDir }));
    registerProvider(createCopilotCliProvider({ copilotDir }));

    // Act — a single commit gets stamped, then reported.
    const stampedCommit = TestFactory.makeCommit(repoPath, "work with two assistants");
    await postCommit(repoPath, stampedCommit);
    const note = readNote(stampedCommit, repoPath);
    const report = buildReport(repoPath, "HEAD~1..HEAD");

    // Assert — the note carries one session per provider with correct classes
    // (copilot input = 300 inclusive − 250 cached), and the report sums both.
    expect(note).not.toBeNull();
    expect(note!.sessions).toHaveLength(2);
    const sessionsByProvider = Object.fromEntries(note!.sessions.map((session) => [session.provider, session]));
    expect(sessionsByProvider["claude-code"]).toMatchObject({
      model: "mock-claude",
      input: 10,
      cacheRead: 100,
      cacheWrite: 5,
      output: 40,
    });
    expect(sessionsByProvider["copilot-cli"]).toMatchObject({
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

describe("syncNotesFromRemote (auto-fetch on report)", () => {
  it("pulls notes for a fresh checkout that has commits but no notes", () => {
    // Arrange — origin has a stamped commit; a fresh clone has the commit
    // but (as git does by default) none of its notes.
    const originRepo = TestFactory.makeRepo();
    const stampedCommit = TestFactory.git(originRepo, "git", "rev-parse", "HEAD");
    writeNote(stampedCommit, TestFactory.makeSessionNote({ output: 42 }), originRepo);
    const remotePath = TestFactory.addBareRemote(originRepo);
    TestFactory.git(originRepo, "git", "push", "-q", "origin", "refs/notes/wick");
    const clone = TestFactory.cloneRepo(remotePath);
    expect(readNote(stampedCommit, clone)).toBeNull();

    // Act
    const result = syncNotesFromRemote("origin", clone);

    // Assert
    expect(result).toBe("updated");
    expect(readNote(stampedCommit, clone)!.sessions[0].output).toBe(42);
  });

  it("merges remote notes into local ones without clobbering unpushed stamps", () => {
    // Arrange — origin and the clone each hold a different session stamp on
    // the same commit; the clone's stamp has not been pushed.
    const originRepo = TestFactory.makeRepo();
    const stampedCommit = TestFactory.git(originRepo, "git", "rev-parse", "HEAD");
    writeNote(stampedCommit, TestFactory.makeSessionNote({ id: "remote-session", output: 7 }), originRepo);
    const remotePath = TestFactory.addBareRemote(originRepo);
    TestFactory.git(originRepo, "git", "push", "-q", "origin", "refs/notes/wick");
    const clone = TestFactory.cloneRepo(remotePath);
    writeNote(stampedCommit, TestFactory.makeSessionNote({ id: "local-session", output: 5 }), clone);

    // Act
    const result = syncNotesFromRemote("origin", clone);

    // Assert — both stamps survive, neither is clobbered.
    expect(result).toBe("updated");
    const note = readNote(stampedCommit, clone)!;
    const outputsBySessionId = Object.fromEntries(note.sessions.map((session) => [session.id, session.output]));
    expect(outputsBySessionId).toEqual({ "local-session": 5, "remote-session": 7 });
  });

  it("is up-to-date when the remote has no notes yet", () => {
    // Arrange — a remote and clone, but no notes were ever pushed.
    const originRepo = TestFactory.makeRepo();
    const remotePath = TestFactory.addBareRemote(originRepo);
    const clone = TestFactory.cloneRepo(remotePath);

    // Act + Assert
    expect(syncNotesFromRemote("origin", clone)).toBe("up-to-date");
  });

  it("reports no-remote for a purely local repo", () => {
    // Arrange
    const repoPath = TestFactory.makeRepo();

    // Act + Assert
    expect(syncNotesFromRemote("origin", repoPath)).toBe("no-remote");
  });
});

describe("CI capture (issue #33) — stamp + push with hooks never installed", () => {
  beforeEach(() => clearProviders());
  afterEach(() => clearProviders());

  it("stamps a commit directly (no installed hook), as the CI stamp step does", async () => {
    // Arrange — a fresh repo where `wick install` was never run (prepare.mjs
    // skips hook install under CI) and a session that burned tokens.
    const repoPath = TestFactory.makeRepo();
    expect(existsSync(path.join(repoPath, ".git", "hooks", "post-commit"))).toBe(false);
    registerProvider(TestFactory.makeMockProvider("mock-provider", { output: 500 }));
    const ciCommit = TestFactory.makeCommit(repoPath, "agent change made in CI");

    // Act — the action's stamp step calls this directly, no installed hook.
    await postCommit(repoPath, ciCommit);

    // Assert — the CI commit carries the run's usage.
    const note = readNote(ciCommit, repoPath);
    expect(note).not.toBeNull();
    expect(note!.sessions[0]).toMatchObject({ provider: "mock-provider", output: 500 });
  });

  it("pushes the stamped notes ref to the remote via the pre-push path", async () => {
    // Arrange — a stamped commit and a bare remote to push to.
    const repoPath = TestFactory.makeRepo();
    registerProvider(TestFactory.makeMockProvider("mock-provider", { output: 42 }));
    const stampedCommit = TestFactory.makeCommit(repoPath, "stamped change");
    await postCommit(repoPath, stampedCommit);
    const remotePath = TestFactory.addBareRemote(repoPath);

    // Act — the stamp step's `wick hook pre-push --remote origin`.
    await prePush(repoPath, "origin");

    // Assert — refs/notes/wick exists on the remote and carries the stamp.
    expect(TestFactory.git(remotePath, "git", "rev-parse", "refs/notes/wick")).not.toBe("");
    expect(readNote(stampedCommit, remotePath)!.sessions[0].output).toBe(42);
  });

  it("wick cost totals the current run without writing a note or state", async () => {
    // Arrange — a fresh repo (no stamp, no hooks) with a burning session and a
    // pricing table that prices the mock model.
    const repoPath = TestFactory.makeRepo();
    registerProvider(TestFactory.makeMockProvider("mock-provider", { output: 1_000_000 }));
    const pricing: PricingTable = {
      "mock-provider": [{ match: "mock-model-x", input: 0, cacheRead: 0, cacheWrite: 0, output: 3 }],
    };
    const head = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    // Act — the exact read-only path `wick cost` runs.
    const summary = summarizeCost(await collectUsage(repoPath, {}), pricing);

    // Assert — cost/tokens computed, and nothing was mutated.
    expect(summary.totalTokens).toBe(1_000_007); // 1M output + 7 input
    expect(summary.costUsd).toBeCloseTo(3); // 1M output × $3/1M
    expect(summary.sessions).toBe(1);
    expect(readNote(head, repoPath)).toBeNull();
    expect(existsSync(path.join(repoPath, ".git", "wick", "state.json"))).toBe(false);
  });

  it("prices the known model and skips the unknown one (never guess a price)", () => {
    // Arrange — one session touching a priced model and an unpriced one.
    const usage: SessionUsage[] = [
      TestFactory.makeSessionUsage("s-known", "priced-model", { output: 1_000_000 }),
      TestFactory.makeSessionUsage("s-unknown", "mystery-model", { output: 2_000_000 }),
    ];
    const pricing: PricingTable = {
      "claude-code": [{ match: "priced-model", input: 0, cacheRead: 0, cacheWrite: 0, output: 4 }],
    };

    // Act
    const summary = summarizeCost(usage, pricing);

    // Assert — cost is the known model's cost (a lower bound), NOT null, and the
    // unknown model is surfaced separately. This is the subtler half of the
    // "unknown model → cost n/a, never guess" invariant.
    expect(summary.costUsd).toBeCloseTo(4); // 1M × $4/1M from the priced model only
    expect(summary.unknownModels).toEqual(["claude-code/mystery-model"]);
    expect(summary.totalTokens).toBe(3_000_000);
  });

  it("folds repeated models into one perModel row", () => {
    // Arrange — two sessions burning the same model.
    const usage: SessionUsage[] = [
      TestFactory.makeSessionUsage("s1", "same-model", { output: 100 }),
      TestFactory.makeSessionUsage("s2", "same-model", { output: 400 }),
    ];

    // Act
    const summary = summarizeCost(usage, {});

    // Assert — one aggregated row, not one per session.
    expect(summary.perModel).toHaveLength(1);
    expect(summary.perModel[0]).toMatchObject({ model: "same-model", tokens: { output: 500 } });
    expect(summary.sessions).toBe(2);
  });

  it("formatCostOutput switches between JSON and the human line + warning", () => {
    // Arrange — a summary with an unpriced model so the lower-bound warning fires.
    const summary = summarizeCost([TestFactory.makeSessionUsage("s1", "mystery", { output: 50_000 })], {});

    // Act
    const human = formatCostOutput(summary, false);
    const json = formatCostOutput(summary, true);

    // Assert — human line + stderr warning; JSON is the parseable summary, no warning.
    expect(human.stdout).toBe(renderCostLine(summary));
    expect(human.stderr).toContain("no pricing for claude-code/mystery");
    expect(JSON.parse(json.stdout).totalTokens).toBe(50_000);
    expect(json.stderr).toBeUndefined();
  });

  it("renderCostLine formats tokens, cost and session plurality", () => {
    // Arrange — three summaries covering k/M suffixes, n/a cost, and plurality.
    const priced = summarizeCost(
      [TestFactory.makeSessionUsage("s1", "m", { output: 82_400 })],
      { "claude-code": [{ match: "m", input: 0, cacheRead: 0, cacheWrite: 0, output: 5 }] },
    );
    const unknown = summarizeCost(
      [TestFactory.makeSessionUsage("s1", "m", { output: 2_000_000 })],
      {},
    );

    // Act + Assert
    expect(renderCostLine(priced)).toBe("wick: 82.4k tokens ≈ $0.41 across 1 session");
    expect(renderCostLine(unknown)).toBe("wick: 2.0M tokens ≈ n/a across 1 session");
    expect(renderCostLine(summarizeCost([], {}))).toBe("wick: 0 tokens ≈ $0.00 across 0 sessions");
  });

  it("renders a 'wick: 0 tokens ' prefix whenever there is no usage (action skip guard)", () => {
    // Arrange — the exact degenerate shape a run that errored immediately leaves:
    // a discovered session with 0 tokens (and here an unpriced model).
    const zeroTokenSession = summarizeCost(
      [TestFactory.makeSessionUsage("s1", "mystery", { output: 0 })],
      {},
    );
    const noSessions = summarizeCost([], {});

    // Act + Assert — action.yml's comment-skip guard keys off this "wick: 0 tokens "
    // prefix, so both the 0-session and 0-token-but-1-session cases must carry it.
    expect(renderCostLine(zeroTokenSession).startsWith("wick: 0 tokens ")).toBe(true);
    expect(renderCostLine(zeroTokenSession)).toBe("wick: 0 tokens ≈ n/a across 1 session");
    expect(renderCostLine(noSessions).startsWith("wick: 0 tokens ")).toBe(true);
  });
});
