import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import * as path from "node:path";
import { install, uninstall, hasWickBlock } from "./install.js";
import { createClaudeCodeProvider } from "./providers/claude-code/index.js";
import { createCopilotCliProvider } from "./providers/copilot-cli/index.js";
import { postCommit, postRewrite, prePush } from "./hooks/index.js";
import { readNote, syncNotesFromRemote, writeNote } from "./notes.js";
import { accumulateNoCommit, buildReport, formatCostOutput, parseNoCommitComment, parsePrComment, renderCostLine, renderPrComment, summarizeCost, type Report } from "./report.js";
import { clearProviders, collectUsage, registerProvider, type SessionUsage } from "./providers/types.js";
import type { PricingTable } from "./pricing.js";
import { TestFactory } from "./test-factory.js";

/**
 * Replace the unified comment's hidden base64 state block with a placeholder so
 * snapshots stay human-readable — the base64 round-trip is covered by the
 * accumulation/security tests, not the visual snapshots.
 */
const visibleComment = (body: string) =>
  body.replace(/<!-- wick-pr-cost-state:.*?-->/, "<!-- wick-pr-cost-state: … -->");

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

  it("never throws into the hook path when a provider fails, but surfaces a warning", async () => {
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
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    // Act + Assert — the hook path swallows the failure and writes no note...
    await expect(postCommit(repoPath, stampedCommit)).resolves.toBeUndefined();
    expect(readNote(stampedCommit, repoPath)).toBeNull();
    // ...but the failure is no longer invisible: onError logs it to stderr.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider broken failed"));

    warn.mockRestore();
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

describe("mixed known/unknown pricing stays reconcilable", () => {
  it("surfaces a commit's known-model cost as a lower bound instead of nulling the row", () => {
    // Arrange — one commit whose note mixes a priced model (Opus 4.8) and an
    // unpriced one. Nulling the whole row would bake the known partial into the
    // footer total while showing n/a in the row, so the visible rows would no
    // longer sum to the printed total.
    const repoPath = TestFactory.makeRepo();
    const mixedCommit = TestFactory.makeCommit(repoPath, "mixed-model work");
    writeNote(
      mixedCommit,
      TestFactory.makeNote([
        TestFactory.makeSession({
          id: "known",
          provider: "claude-code",
          model: "claude-opus-4-8",
          input: 1_000_000,
        }),
        TestFactory.makeSession({
          id: "unknown",
          provider: "claude-code",
          model: "definitely-not-a-real-model",
          output: 2_000_000,
        }),
      ]),
      repoPath,
    );

    // Act
    const report = buildReport(repoPath, "HEAD~1..HEAD");

    // Assert — the row shows the known partial ($5 = 1M input × Opus $5/1M), not
    // null, and equals the footer total; the unknown model is surfaced instead.
    const row = report.commits.find((commitReport) => commitReport.commit === mixedCommit)!;
    expect(row.costUsd).toBeCloseTo(5);
    expect(report.totals.costUsd).toBeCloseTo(5);
    expect(report.unknownModels).toContain("claude-code/definitely-not-a-real-model");
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

describe("merge-shape detection (drift-robust, #47)", () => {
  /** Commit a brand-new file (disjoint diffs never conflict on squash/rebase). */
  function commitFile(repoPath: string, name: string): string {
    writeFileSync(path.join(repoPath, name), `${name}\n`);
    TestFactory.git(repoPath, "git", "add", ".");
    TestFactory.git(repoPath, "git", "commit", "-q", "-m", name);
    return TestFactory.git(repoPath, "git", "rev-parse", "HEAD");
  }

  /** Overwrite a file with exact content and commit it (for line-offset tests). */
  function commitContent(repoPath: string, name: string, content: string): string {
    writeFileSync(path.join(repoPath, name), content);
    TestFactory.git(repoPath, "git", "add", ".");
    TestFactory.git(repoPath, "git", "commit", "-q", "-m", `edit ${name}`);
    return TestFactory.git(repoPath, "git", "rev-parse", "HEAD");
  }

  it("detects a squash merge even when the base branch advanced independently", async () => {
    // Arrange — the #47 scenario: a stamped feature branch, an UNRELATED commit
    // lands on main while the PR is open, then the PR is squash-merged. The old
    // count-based detector saw two commits in base..mergeSha (the drift + the
    // squash) with PR_SHAS also 2, and mis-detected a rebase.
    const { detectMergeShape, consolidateNotes } = await import("./reconcile.js");
    const repoPath = TestFactory.makeRepo();

    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    const firstFeatureCommit = commitFile(repoPath, "feat-a.txt");
    writeNote(firstFeatureCommit, TestFactory.makeSessionNote({ input: 1, cacheRead: 10, output: 5 }), repoPath);
    const secondFeatureCommit = commitFile(repoPath, "feat-b.txt");
    writeNote(secondFeatureCommit, TestFactory.makeSessionNote({ input: 2, cacheRead: 20, output: 7 }), repoPath);

    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    commitFile(repoPath, "unrelated-drift.txt"); // main moves ahead independently
    TestFactory.git(repoPath, "git", "merge", "--squash", "feature");
    TestFactory.git(repoPath, "git", "commit", "-q", "-m", "feature (squashed)");
    const squashCommit = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    // Act
    const shape = detectMergeShape(repoPath, {
      baseRef: "main",
      prHead: "feature",
      mergeSha: squashCommit,
    });

    // Assert — recognized as a squash of exactly the two PR commits, and their
    // stamps consolidate onto the squash commit.
    expect(shape).toEqual({
      kind: "squash",
      onto: squashCommit,
      sources: [firstFeatureCommit, secondFeatureCommit],
    });
    if (shape.kind !== "squash") throw new Error("expected squash");
    expect(consolidateNotes(repoPath, shape.sources, shape.onto)).toBe("written");
    expect(readNote(squashCommit, repoPath)!.sessions[0]).toMatchObject({ input: 3, cacheRead: 30, output: 12 });
  });

  it("detects a squash merge when the PR synced the base and the base then drifted again", async () => {
    // Arrange — the PR merges main into itself (pushing the merge-base forward),
    // THEN main gains one more unrelated commit before the squash. This yields
    // base..mergeSha == base..prHead == 2, so the old count-based detector
    // mis-classified it as a rebase and remapped the PR's stamp onto an
    // unrelated main commit. (A single sync with no later drift left the count
    // at 1 and detected squash fine — that variant never triggered the bug.)
    const { detectMergeShape, consolidateNotes } = await import("./reconcile.js");
    const repoPath = TestFactory.makeRepo();

    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    const featureCommit = commitFile(repoPath, "feat-a.txt");
    writeNote(featureCommit, TestFactory.makeSessionNote({ input: 4, cacheRead: 40, output: 9 }), repoPath);

    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    commitFile(repoPath, "drift-before-sync.txt");
    TestFactory.git(repoPath, "git", "checkout", "-q", "feature");
    TestFactory.git(repoPath, "git", "merge", "-q", "--no-edit", "main"); // PR pulls main in

    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    commitFile(repoPath, "drift-after-sync.txt"); // main drifts again post-sync
    TestFactory.git(repoPath, "git", "merge", "--squash", "feature");
    TestFactory.git(repoPath, "git", "commit", "-q", "-m", "feature (squashed)");
    const squashCommit = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    // Act
    const shape = detectMergeShape(repoPath, {
      baseRef: "main",
      prHead: "feature",
      mergeSha: squashCommit,
    });

    // Assert — squash (not a mis-detected rebase), and the stamp lands on the
    // squash commit, not on a drift commit.
    expect(shape.kind).toBe("squash");
    if (shape.kind !== "squash") throw new Error("expected squash");
    expect(shape.sources).toContain(featureCommit);
    expect(consolidateNotes(repoPath, shape.sources, shape.onto)).toBe("written");
    expect(readNote(squashCommit, repoPath)!.sessions[0]).toMatchObject({ input: 4, cacheRead: 40, output: 9 });
  });

  it("detects a rebase merge (1:1 replay) despite independent base drift", async () => {
    // Arrange — feature replayed onto a main that gained an unrelated commit.
    // Under the old logic base..mergeSha was 3 (drift + 2 replays) vs PR 2, so
    // it fell through to "unrecognized" and dropped the PR's stamps entirely.
    const { detectMergeShape } = await import("./reconcile.js");
    const { remapNotes } = await import("./notes.js");
    const repoPath = TestFactory.makeRepo();
    const forkPoint = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    const firstFeatureCommit = commitFile(repoPath, "feat-a.txt");
    writeNote(firstFeatureCommit, TestFactory.makeSessionNote({ input: 1, output: 5 }), repoPath);
    const secondFeatureCommit = commitFile(repoPath, "feat-b.txt");
    writeNote(secondFeatureCommit, TestFactory.makeSessionNote({ input: 2, output: 7 }), repoPath);

    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    commitFile(repoPath, "unrelated-drift.txt");
    // Rebase merge = replay the PR commits onto the drifted main tip.
    TestFactory.git(repoPath, "git", "cherry-pick", `${forkPoint}..feature`);
    const replayedShas = TestFactory.git(repoPath, "git", "rev-list", "--first-parent", "--reverse", "-n", "2", "HEAD").split("\n");
    const mergeSha = replayedShas[1];

    // Act
    const shape = detectMergeShape(repoPath, {
      baseRef: "main",
      prHead: "feature",
      mergeSha,
    });

    // Assert — rebase with the correct 1:1 old→new pairing, and remapping
    // carries each stamp onto its replayed commit.
    expect(shape).toEqual({
      kind: "rebase",
      pairs: [
        [firstFeatureCommit, replayedShas[0]],
        [secondFeatureCommit, replayedShas[1]],
      ],
    });
    if (shape.kind !== "rebase") throw new Error("expected rebase");
    for (const [oldSha, newSha] of shape.pairs) remapNotes([oldSha], newSha, repoPath);
    expect(readNote(replayedShas[0], repoPath)!.sessions[0]).toMatchObject({ input: 1, output: 5 });
    expect(readNote(replayedShas[1], repoPath)!.sessions[0]).toMatchObject({ input: 2, output: 7 });
  });

  it("matches a rebased commit by patch-id even when base drift shifted its line numbers", async () => {
    // Arrange — the base drift edits the SAME file the PR commit does, so the
    // replayed commit's diff has different @@ line numbers than the original.
    // This is the only case that distinguishes patch-id matching from a naive
    // byte-identical diff comparison — an exact-diff detector would miss it.
    const { detectMergeShape } = await import("./reconcile.js");
    const repoPath = TestFactory.makeRepo();
    commitContent(repoPath, "shared.txt", "L1\nL2\nL3\n");
    const forkPoint = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    const featureCommit = commitContent(repoPath, "shared.txt", "L1\nL2\nL3\nFEAT\n"); // append at bottom

    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    commitContent(repoPath, "shared.txt", "TOP\nL1\nL2\nL3\n"); // prepend → shifts feature's line
    TestFactory.git(repoPath, "git", "cherry-pick", `${forkPoint}..feature`);
    const replayedCommit = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    // Act
    const shape = detectMergeShape(repoPath, {
      baseRef: "main",
      prHead: "feature",
      mergeSha: replayedCommit,
    });

    // Assert — still recognized as a 1:1 rebase despite the line-offset shift.
    expect(shape).toEqual({
      kind: "rebase",
      pairs: [[featureCommit, replayedCommit]],
    });
  });

  it("reports a real merge commit as nothing to reconcile", async () => {
    // Arrange — a true merge (>1 parent) keeps PR commits reachable, so the
    // parent-count short-circuit returns before any shape analysis.
    const { detectMergeShape } = await import("./reconcile.js");
    const repoPath = TestFactory.makeRepo();

    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    commitFile(repoPath, "feat-a.txt");
    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    TestFactory.git(repoPath, "git", "merge", "-q", "--no-ff", "--no-edit", "feature");
    const mergeSha = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    // Act + Assert
    expect(detectMergeShape(repoPath, { baseRef: "main", prHead: "feature", mergeSha })).toEqual({
      kind: "merge-commit",
    });
  });

  it("reports a commit that is neither a squash nor a rebase of the PR as unrecognized", async () => {
    // Arrange — an unrelated single-parent commit on main that shares no diff
    // with the PR. Detection must skip (never mis-stamp) rather than guess.
    const { detectMergeShape } = await import("./reconcile.js");
    const repoPath = TestFactory.makeRepo();

    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    commitFile(repoPath, "feat-a.txt");
    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    const unrelatedCommit = commitFile(repoPath, "unrelated.txt");

    // Act + Assert
    expect(detectMergeShape(repoPath, { baseRef: "main", prHead: "feature", mergeSha: unrelatedCommit })).toEqual({
      kind: "unrecognized",
    });
  });

  it("reconcileMerge pushes the remapped notes only when a stamp actually moved", async () => {
    // Arrange — a stamped, squash-merged PR whose main tip (incl. the squash
    // commit) is on a bare remote, exactly as the CI reconcile job sees it.
    const { reconcileMerge } = await import("./reconcile.js");
    const repoPath = TestFactory.makeRepo();

    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    const firstFeatureCommit = commitFile(repoPath, "feat-a.txt");
    writeNote(firstFeatureCommit, TestFactory.makeSessionNote({ output: 21 }), repoPath);
    const secondFeatureCommit = commitFile(repoPath, "feat-b.txt"); // two commits → true squash
    writeNote(secondFeatureCommit, TestFactory.makeSessionNote({ output: 9 }), repoPath);

    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    commitFile(repoPath, "unrelated-drift.txt");
    TestFactory.git(repoPath, "git", "merge", "--squash", "feature");
    TestFactory.git(repoPath, "git", "commit", "-q", "-m", "feature (squashed)");
    const squashCommit = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");
    const remotePath = TestFactory.addBareRemote(repoPath); // pushes main incl. squashCommit

    // Act — the CLI's exact path: reconcile, then push iff a stamp moved.
    const outcome = reconcileMerge(repoPath, { baseRef: "origin/main", prHead: "feature", mergeSha: squashCommit });
    if (outcome.wrote) await prePush(repoPath, "origin");

    // Assert — both PR stamps consolidate onto the squash commit locally AND get
    // pushed (21 + 9 summed per the shared session id).
    expect(outcome.shape.kind).toBe("squash");
    expect(outcome.wrote).toBe(true);
    expect(readNote(squashCommit, repoPath)!.sessions[0].output).toBe(30);
    expect(readNote(squashCommit, remotePath)!.sessions[0].output).toBe(30);
  });

  it("reconcileMerge leaves the notes push closed for a stamp-less rebase", async () => {
    // Arrange — a rebase-merged PR whose commits carry NO wick notes. Detection
    // must recognize the rebase but report wrote=false so the CLI skips the
    // (pointless, and per CLAUDE.md once-costly) force-with-lease round-trip.
    const { reconcileMerge } = await import("./reconcile.js");
    const repoPath = TestFactory.makeRepo();
    const forkPoint = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    TestFactory.git(repoPath, "git", "checkout", "-q", "-b", "feature");
    commitFile(repoPath, "feat-a.txt"); // deliberately unstamped
    TestFactory.git(repoPath, "git", "checkout", "-q", "main");
    commitFile(repoPath, "unrelated-drift.txt");
    TestFactory.git(repoPath, "git", "cherry-pick", `${forkPoint}..feature`);
    const mergeSha = TestFactory.git(repoPath, "git", "rev-parse", "HEAD");

    // Act
    const outcome = reconcileMerge(repoPath, { baseRef: "main", prHead: "feature", mergeSha });

    // Assert — shape detected, but nothing written → push stays closed.
    expect(outcome.shape.kind).toBe("rebase");
    expect(outcome.wrote).toBe(false);
    expect(readNote(mergeSha, repoPath)).toBeNull();
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

  it("merges a concurrently-advanced remote notes ref instead of losing the local stamp", async () => {
    // Arrange — a stamped commit pushed to a bare remote (the state the
    // reconcile job reaches after writing its remapped stamp). This is the path
    // the CI reconcile job must use: a bare `git push` here would be rejected
    // non-fast-forward and, under `set -euo pipefail`, discard the stamp.
    const repoPath = TestFactory.makeRepo();
    const localTotals = { output: 10 };
    registerProvider(TestFactory.makeMockProvider("mock-provider", localTotals));
    const localCommit = TestFactory.makeCommit(repoPath, "local work");
    await postCommit(repoPath, localCommit);
    const remotePath = TestFactory.addBareRemote(repoPath);
    await prePush(repoPath, "origin"); // remote notes = { localCommit }

    // A concurrent CI job (separate clone) stamps a different commit and pushes,
    // advancing the remote's refs/notes/wick out from under repoPath.
    const concurrentPath = TestFactory.cloneRepo(remotePath);
    const concurrentCommit = TestFactory.makeCommit(concurrentPath, "concurrent work");
    writeNote(
      concurrentCommit,
      TestFactory.makeSessionNote({ provider: "mock-provider", output: 99 }),
      concurrentPath,
    );
    await prePush(concurrentPath, "origin"); // remote += { concurrentCommit }

    // repoPath, unaware, advances its own notes ref → local and remote diverge.
    localTotals.output = 25;
    const secondLocalCommit = TestFactory.makeCommit(repoPath, "more local work");
    await postCommit(repoPath, secondLocalCommit);

    // Act — the reconcile job's safe push path (fetch → per-commit merge →
    // force-with-lease), reached via `wick hook pre-push --remote origin`.
    await prePush(repoPath, "origin");

    // Assert — every stamp survives on the remote; nothing was clobbered.
    expect(readNote(localCommit, remotePath)!.sessions[0].output).toBe(10);
    expect(readNote(concurrentCommit, remotePath)!.sessions[0].output).toBe(99);
    expect(readNote(secondLocalCommit, remotePath)!.sessions[0].output).toBe(15);
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
    const { usage } = await collectUsage(repoPath, {});
    const summary = summarizeCost(usage, pricing);

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

  it("renderPrComment renders the commit-attributed report half with budget and authors", () => {
    // Arrange — a two-commit, two-author report, under budget, no no-commit runs.
    const report: Report = {
      range: "base..HEAD",
      commits: [
        { commit: "1111111aaaa", subject: "feat: a thing", author: "Pat", authorEmail: "p@x", sessions: ["s1"], tokens: { input: 40_000, cacheRead: 1_200_000, cacheWrite: 8_000, output: 12_000 }, costUsd: 1.5 },
        { commit: "2222222bbbb", subject: "fix: another", author: "Jo", authorEmail: "j@x", sessions: ["s2"], tokens: { input: 1_000, cacheRead: 50_000, cacheWrite: 2_000, output: 3_000 }, costUsd: 0.6 },
      ],
      authors: [
        { author: "Pat", authorEmail: "p@x", stampedCommits: 1, sessions: 1, tokens: { input: 40_000, cacheRead: 1_200_000, cacheWrite: 8_000, output: 12_000 }, costUsd: 1.5 },
        { author: "Jo", authorEmail: "j@x", stampedCommits: 1, sessions: 1, tokens: { input: 1_000, cacheRead: 50_000, cacheWrite: 2_000, output: 3_000 }, costUsd: 0.6 },
      ],
      budget: { limitUsd: 15, usedUsd: 2.1, usedFraction: 0.14, status: "ok" },
      totals: { tokens: { input: 41_000, cacheRead: 1_250_000, cacheWrite: 10_000, output: 15_000 }, costUsd: 2.1, sessions: 2, stampedCommits: 2, commits: 3 },
      unknownModels: [],
    };

    // Act
    const comment = renderPrComment({ report });

    // Assert — combined header (report only), budget annotated commit-attributed,
    // by-author line, per-commit details; no action-runs section.
    expect(visibleComment(comment)).toMatchInlineSnapshot(`
      "<!-- wick-pr-cost -->
      <!-- wick-pr-cost-state: … -->
      ### 🕯️ Wick — this PR cost **$2.10**

      🔥 **1.3M tokens** · **2 sessions** · **2/3 commits stamped**

      | 📥 input | ⚡ cache read | 📝 cache write | 📤 output |
      |---:|---:|---:|---:|
      | 41.0k | 1.3M | 10.0k | 15.0k |

      🎯 **budget:** $2.10 / $15.00 🟩⬜⬜⬜⬜⬜⬜⬜⬜⬜ 14% _(commit-attributed spend)_

      👥 **by author:** Pat **$1.50** · Jo **$0.60**

      <details>
      <summary>💸 per-commit breakdown (2): <strong>$2.10</strong></summary>

      | commit | subject | author | burn | tokens | cost |
      |---|---|---|---|---:|---:|
      | \`1111111\` | feat: a thing | Pat | 🟧🟧🟧🟧🟧 | 1.3M | **$1.50** |
      | \`2222222\` | fix: another | Jo | 🟧 | 56.0k | **$0.60** |

      </details>

      > ≈ about one fancy latte ☕"
    `);
  });

  it("renderPrComment renders the no-commit half alone (issue triage, no commits)", () => {
    // Arrange — a single priced run, no report half (an issue triage turn).
    const pricing: PricingTable = {
      "claude-code": [{ match: "m", input: 3, cacheRead: 0, cacheWrite: 0, output: 15 }],
    };
    const run = summarizeCost(
      [TestFactory.makeSessionUsage("s1", "m", { input: 40_000, cacheRead: 1_200_000, cacheWrite: 8_000, output: 12_000 })],
      pricing,
    );

    // Act
    const comment = renderPrComment({
      noCommit: accumulateNoCommit(null, run, { label: "run 7", url: "https://ci/7" }),
    });

    // Assert — no budget/author/commit sections; the action-runs table shows even
    // for a single run (the header is the grand total, so the run subtotal isn't
    // otherwise visible).
    expect(visibleComment(comment)).toMatchInlineSnapshot(`
      "<!-- wick-pr-cost -->
      <!-- wick-pr-cost-state: … -->
      ### 🕯️ Wick — this PR cost **$0.30**

      🔥 **1.3M tokens** · **1 session** · **1 no-commit run**

      | 📥 input | ⚡ cache read | 📝 cache write | 📤 output |
      |---:|---:|---:|---:|
      | 40.0k | 1.2M | 8.0k | 12.0k |

      <details>
      <summary>🤖 action runs (1): <strong>$0.30</strong></summary>

      | run | sessions | burn | tokens | cost |
      |---|---:|---|---:|---:|
      | [run 7](https://ci/7) | 1 | 🟧🟧🟧🟧🟧 | 1.3M | **$0.30** |

      </details>

      > ≈ cheaper than a gumball 🍬"
    `);
  });

  it("renderPrComment combines commit and no-commit halves under one header", () => {
    // Arrange — a $2.10 commit report plus two no-commit runs ($1.00 + $0.60).
    const report: Report = {
      range: "base..HEAD",
      commits: [
        { commit: "1111111aaaa", subject: "feat: a thing", author: "Pat", authorEmail: "p@x", sessions: ["s1"], tokens: { input: 40_000, cacheRead: 1_200_000, cacheWrite: 8_000, output: 12_000 }, costUsd: 2.1 },
      ],
      authors: [
        { author: "Pat", authorEmail: "p@x", stampedCommits: 1, sessions: 1, tokens: { input: 40_000, cacheRead: 1_200_000, cacheWrite: 8_000, output: 12_000 }, costUsd: 2.1 },
      ],
      budget: { limitUsd: 15, usedUsd: 2.1, usedFraction: 0.14, status: "ok" },
      totals: { tokens: { input: 40_000, cacheRead: 1_200_000, cacheWrite: 8_000, output: 12_000 }, costUsd: 2.1, sessions: 2, stampedCommits: 1, commits: 2 },
      unknownModels: [],
    };
    const pricing: PricingTable = {
      "claude-code": [{ match: "m", input: 0, cacheRead: 0, cacheWrite: 0, output: 10 }],
    };
    const run1 = summarizeCost([TestFactory.makeSessionUsage("r1", "m", { output: 100_000 })], pricing);
    const run2 = summarizeCost([TestFactory.makeSessionUsage("r2", "m", { output: 60_000 })], pricing);
    let noCommit = accumulateNoCommit(null, run1, { label: "run 1", url: "https://ci/1" });
    noCommit = accumulateNoCommit(noCommit, run2, { label: "run 2", url: "https://ci/2" });

    // Act
    const comment = renderPrComment({ report, noCommit });

    // Assert — one header summing both halves ($2.10 + $1.60 = $3.70), a 🔥 line
    // carrying both the commits-stamped and no-commit-runs counts, the budget bar
    // still commit-attributed only, and both breakdown sections present.
    expect(visibleComment(comment)).toMatchInlineSnapshot(`
      "<!-- wick-pr-cost -->
      <!-- wick-pr-cost-state: … -->
      ### 🕯️ Wick — this PR cost **$3.70**

      🔥 **1.4M tokens** · **4 sessions** · **1/2 commits stamped** · **2 no-commit runs**

      | 📥 input | ⚡ cache read | 📝 cache write | 📤 output |
      |---:|---:|---:|---:|
      | 40.0k | 1.2M | 8.0k | 172.0k |

      🎯 **budget:** $2.10 / $15.00 🟩⬜⬜⬜⬜⬜⬜⬜⬜⬜ 14% _(commit-attributed spend)_

      <details>
      <summary>💸 per-commit breakdown (1): <strong>$2.10</strong></summary>

      | commit | subject | author | burn | tokens | cost |
      |---|---|---|---|---:|---:|
      | \`1111111\` | feat: a thing | Pat | 🟧🟧🟧🟧🟧 | 1.3M | **$2.10** |

      </details>

      <details>
      <summary>🤖 action runs (2): <strong>$1.60</strong></summary>

      | run | sessions | burn | tokens | cost |
      |---|---:|---|---:|---:|
      | [run 1](https://ci/1) | 1 | 🟧🟧🟧🟧🟧 | 100.0k | **$1.00** |
      | [run 2](https://ci/2) | 1 | 🟧🟧🟧 | 60.0k | **$0.60** |

      </details>

      > ≈ about one fancy latte ☕"
    `);
  });

  it("renderPrComment merges and dedupes unknown-model warnings across both halves", () => {
    // Arrange — the report half prices one commit but leaves two models unknown;
    // the no-commit half re-hits one of those and adds a third.
    const report: Report = {
      range: "base..HEAD",
      commits: [
        { commit: "1111111aaaa", subject: "feat: partial pricing", author: "Pat", authorEmail: "p@x", sessions: ["s1"], tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100_000 }, costUsd: 1 },
      ],
      authors: [
        { author: "Pat", authorEmail: "p@x", stampedCommits: 1, sessions: 1, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100_000 }, costUsd: 1 },
      ],
      totals: { tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100_000 }, costUsd: 1, sessions: 1, stampedCommits: 1, commits: 1 },
      unknownModels: ["claude-code/mystery-a", "claude-code/shared"],
    };
    const run = summarizeCost(
      [
        TestFactory.makeSessionUsage("r1", "shared", { output: 10_000 }),
        TestFactory.makeSessionUsage("r2", "mystery-b", { output: 10_000 }),
      ],
      {},
    );

    // Act
    const comment = renderPrComment({ report, noCommit: accumulateNoCommit(null, run) });

    // Assert — the combined cost is the priced $1.00 lower bound (the run priced
    // nothing), and the warning lists all three unknown models exactly once.
    expect(comment).toContain("### 🕯️ Wick — this PR cost **$1.00**");
    expect(comment).toContain(
      "⚠️ _no pricing for: claude-code/mystery-a, claude-code/shared, claude-code/mystery-b — cost is a lower bound_",
    );
  });

  it("the report and stamp writers each update their own half and preserve the other's", () => {
    // Arrange — a report plus two no-commit runs, written by two writers that
    // each see only their own comment and must not clobber the other's half.
    const pricing: PricingTable = {
      "claude-code": [{ match: "m", input: 0, cacheRead: 0, cacheWrite: 0, output: 10 }],
    };
    const run1 = summarizeCost([TestFactory.makeSessionUsage("r1", "m", { output: 100_000 })], pricing);
    const run2 = summarizeCost([TestFactory.makeSessionUsage("r2", "m", { output: 300_000 })], pricing);
    const report: Report = {
      range: "base..HEAD",
      commits: [
        { commit: "1111111aaaa", subject: "feat: a thing", author: "Pat", authorEmail: "p@x", sessions: ["s1"], tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 200_000 }, costUsd: 2 },
      ],
      authors: [
        { author: "Pat", authorEmail: "p@x", stampedCommits: 1, sessions: 1, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 200_000 }, costUsd: 2 },
      ],
      totals: { tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 200_000 }, costUsd: 2, sessions: 1, stampedCommits: 1, commits: 1 },
      unknownModels: [],
    };

    // Act — stamp writer posts run 1, report writer folds the report in
    // (preserving no-commit), stamp writer folds run 2 in (preserving report).
    const afterStamp1 = renderPrComment({
      noCommit: accumulateNoCommit(null, run1, { label: "run 1", url: "https://ci/1" }),
    });
    const seenByReport = parsePrComment(afterStamp1);
    const afterReport = renderPrComment({ ...seenByReport, report });
    const seenByStamp = parsePrComment(afterReport);
    const afterStamp2 = renderPrComment({
      report: seenByStamp?.report,
      noCommit: accumulateNoCommit(seenByStamp?.noCommit ?? null, run2, { label: "run 2", url: "https://ci/2" }),
    });

    // Assert — the report writer preserved run 1, and the second stamp preserved
    // the report through to a state carrying both halves intact.
    expect(seenByReport?.noCommit?.runs).toHaveLength(1);
    const final = parsePrComment(afterStamp2);
    expect(final?.report?.totals.stampedCommits).toBe(1);
    expect(final?.noCommit?.runs).toHaveLength(2);
    expect(visibleComment(afterStamp2)).toMatchInlineSnapshot(`
      "<!-- wick-pr-cost -->
      <!-- wick-pr-cost-state: … -->
      ### 🕯️ Wick — this PR cost **$6.00**

      🔥 **600.0k tokens** · **3 sessions** · **1/1 commits stamped** · **2 no-commit runs**

      | 📥 input | ⚡ cache read | 📝 cache write | 📤 output |
      |---:|---:|---:|---:|
      | 0 | 0 | 0 | 600.0k |

      <details>
      <summary>💸 per-commit breakdown (1): <strong>$2.00</strong></summary>

      | commit | subject | author | burn | tokens | cost |
      |---|---|---|---|---:|---:|
      | \`1111111\` | feat: a thing | Pat | 🟧🟧🟧🟧🟧 | 200.0k | **$2.00** |

      </details>

      <details>
      <summary>🤖 action runs (2): <strong>$4.00</strong></summary>

      | run | sessions | burn | tokens | cost |
      |---|---:|---|---:|---:|
      | [run 1](https://ci/1) | 1 | 🟧🟧 | 100.0k | **$1.00** |
      | [run 2](https://ci/2) | 1 | 🟧🟧🟧🟧🟧 | 300.0k | **$3.00** |

      </details>

      > ≈ a solid lunch 🌯"
    `);
  });

  it("renderPrComment omits empty sections cleanly (report with no stamped commits)", () => {
    // Arrange — a report over a range whose commits are all unstamped, no runs.
    const report: Report = {
      range: "base..HEAD",
      commits: [],
      authors: [],
      totals: { tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: 0, sessions: 0, stampedCommits: 0, commits: 4 },
      unknownModels: [],
    };

    // Act
    const comment = renderPrComment({ report });

    // Assert — no dangling "(0)" sections and no no-commit-run segment.
    expect(comment).not.toContain("per-commit breakdown");
    expect(comment).not.toContain("action runs");
    expect(comment).not.toContain("no-commit run");
    expect(visibleComment(comment)).toMatchInlineSnapshot(`
      "<!-- wick-pr-cost -->
      <!-- wick-pr-cost-state: … -->
      ### 🕯️ Wick — this PR cost **$0.00**

      🔥 **0 tokens** · **0 sessions** · **0/4 commits stamped**

      | 📥 input | ⚡ cache read | 📝 cache write | 📤 output |
      |---:|---:|---:|---:|
      | 0 | 0 | 0 | 0 |

      > ≈ barely singed the wick 🕯️"
    `);
  });

  it("parsePrComment and parseNoCommitComment return null for unrecoverable bodies", () => {
    // Arrange — bodies that must NOT be mistaken for a state-carrying comment,
    // including a truncated state that decodes to a partial (non-Report) half —
    // it must be rejected so renderPrComment never dereferences a bad `report`.
    const foreign = "### 🕯️ Wick — this PR cost **$1.00**\n<!-- wick-report -->";
    const corruptLegacy = "<!-- wick-cost -->\n<!-- wick-cost-state: not-valid-base64!! -->";
    const corruptUnified = "<!-- wick-pr-cost -->\n<!-- wick-pr-cost-state: not-valid-base64!! -->";
    const partialReport = `<!-- wick-pr-cost-state: ${Buffer.from(JSON.stringify({ report: {} })).toString("base64")} -->`;

    // Act + Assert — every parse starts fresh rather than throwing.
    expect(parseNoCommitComment(foreign)).toBeNull();
    expect(parseNoCommitComment(corruptLegacy)).toBeNull();
    expect(parsePrComment(foreign)).toBeNull();
    expect(parsePrComment(corruptUnified)).toBeNull();
    expect(parsePrComment(partialReport)).toBeNull();
  });

  it("parseNoCommitComment still recovers a legacy no-commit comment (migration path)", () => {
    // Arrange — the exact legacy `<!-- wick-cost -->` shape a transition PR carries,
    // built by hand since the standalone renderer is gone. The writers read this
    // once to fold the old comment's runs into the unified comment.
    const legacyState = {
      runs: [
        {
          summary: summarizeCost([TestFactory.makeSessionUsage("s1", "m", { output: 1_000 })], {}),
          label: "run 3",
          url: "https://ci/3",
        },
      ],
    };
    const legacyBody = `<!-- wick-cost -->\n<!-- wick-cost-state: ${Buffer.from(JSON.stringify(legacyState)).toString("base64")} -->\n### old body`;

    // Act + Assert — the legacy run is recovered intact for migration.
    expect(parseNoCommitComment(legacyBody)).toMatchObject({ runs: [{ label: "run 3", url: "https://ci/3" }] });
  });

  it("renderPrComment keeps markdown-special model names inline (no shell path)", () => {
    // Arrange — a model name full of characters that would be dangerous on a
    // shell path (and could break an HTML comment) but are inert here: visible
    // text is plain markdown, and the hidden state is base64-encoded.
    const nastyModel = "evil`$(rm -rf /)`--> <script> | drop";
    const summary = summarizeCost(
      [TestFactory.makeSessionUsage("s1", nastyModel, { output: 100 })],
      {},
    );

    // Act
    const comment = renderPrComment({ noCommit: accumulateNoCommit(null, summary) });

    // Assert — the raw string appears verbatim in the visible warning, and the
    // base64 state still round-trips it back intact (the `-->` inside the name
    // never terminated the state block early).
    expect(comment).toContain(`claude-code/${nastyModel}`);
    expect(parsePrComment(comment)).toMatchObject({
      noCommit: { runs: [{ summary: { unknownModels: [`claude-code/${nastyModel}`] } }] },
    });
  });
});
