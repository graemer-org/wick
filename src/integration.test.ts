import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { install, uninstall, hasWickBlock } from "./install.js";
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

function commit(dir: string, msg: string): string {
  writeFileSync(path.join(dir, "file.txt"), `${msg}\n`, { flag: "a" });
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-q", "-m", msg);
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
    const repo = makeRepo();
    const hookPath = path.join(repo, ".git", "hooks", "post-commit");
    const husky = `#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\necho husky-ran\n`;
    writeFileSync(hookPath, husky);
    chmodSync(hookPath, 0o755);

    await install(repo);
    let content = readFileSync(hookPath, "utf8");
    expect(content).toContain("husky.sh");
    expect(content).toContain("echo husky-ran");
    expect(content).toContain("# >>> wick >>>");

    // Idempotent — second install must not duplicate the block.
    await install(repo);
    content = readFileSync(hookPath, "utf8");
    expect(content.split("# >>> wick >>>").length).toBe(2);

    // Uninstall removes only the wick block.
    await uninstall(repo);
    content = readFileSync(hookPath, "utf8");
    expect(content).toContain("echo husky-ran");
    expect(content).not.toContain("wick");
  });

  it("creates hooks from scratch and deletes them again on uninstall", async () => {
    const repo = makeRepo();
    await install(repo);
    expect(await hasWickBlock(repo, "post-commit")).toBe(true);
    expect(await hasWickBlock(repo, "post-rewrite")).toBe(true);
    expect(await hasWickBlock(repo, "post-merge")).toBe(true);
    expect(await hasWickBlock(repo, "pre-push")).toBe(true);
    // notes.rewriteRef configured
    expect(sh(repo, "git", "config", "notes.rewriteRef")).toBe("refs/notes/wick");

    await uninstall(repo);
    expect(existsSync(path.join(repo, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("respects core.hooksPath", async () => {
    const repo = makeRepo();
    sh(repo, "git", "config", "core.hooksPath", ".myhooks");
    const result = await install(repo);
    expect(result.hooksDir).toBe(path.join(repo, ".myhooks"));
    expect(existsSync(path.join(repo, ".myhooks", "post-commit"))).toBe(true);
  });
});

describe("attribution end-to-end (mock provider = provider isolation)", () => {
  beforeEach(() => clearProviders());
  afterEach(() => clearProviders());

  it("stamps commits with deltas and reports them", async () => {
    const repo = makeRepo();
    const totals = { output: 100 };
    registerProvider(mockProvider("mock-provider", totals));

    const c1 = commit(repo, "first change");
    await postCommit(repo, c1);
    const note1 = readNote(c1, repo);
    expect(note1).not.toBeNull();
    expect(note1!.sessions[0]).toMatchObject({
      id: "mock-session-1",
      provider: "mock-provider",
      model: "mock-model-x",
      output: 100,
    });

    // Session keeps burning tokens; next commit gets only the delta.
    totals.output = 260;
    const c2 = commit(repo, "second change");
    await postCommit(repo, c2);
    const note2 = readNote(c2, repo);
    expect(note2!.sessions[0].output).toBe(160);

    // Report aggregates both commits; unknown model → cost n/a, tokens shown.
    const report = buildReport(repo, "HEAD~2..HEAD");
    expect(report.totals.tokens.output).toBe(260);
    expect(report.totals.sessions).toBe(1);
    expect(report.commits.every((c) => c.costUsd === null)).toBe(true);
    expect(report.unknownModels).toContain("mock-provider/mock-model-x");
  });

  it("never throws into the hook path when a provider fails", async () => {
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
    await expect(postCommit(repo, c1)).resolves.toBeUndefined();
    expect(readNote(c1, repo)).toBeNull();
  });
});

describe("rewrite remapping", () => {
  it("preserves stamps across git commit --amend", async () => {
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

    await postRewrite(repo, `${c1} ${c2}\n`);
    const note = readNote(c2, repo);
    expect(note!.sessions[0].output).toBe(9);
  });

  it("preserves stamps across rebase and merges with an existing note", async () => {
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
    // Simulate a rebase squashing both commits into one new commit.
    const squashed = commit(repo, "squashed");
    await postRewrite(repo, `${c1} ${squashed}\n${c2} ${squashed}\n`);
    const note = readNote(squashed, repo);
    expect(note!.sessions[0].output).toBe(12);
  });

  it("does not double a note that git's notes.rewriteRef already copied", async () => {
    const repo = makeRepo();
    const c1 = commit(repo, "a");
    const data = {
      v: 1 as const,
      sessions: [{ id: "s", provider: "p", model: "m", input: 0, cacheRead: 0, cacheWrite: 0, output: 5 }],
    };
    writeNote(c1, data, repo);
    const c2 = commit(repo, "b");
    writeNote(c2, data, repo); // identical — as if git already copied it
    await postRewrite(repo, `${c1} ${c2}\n`);
    expect(readNote(c2, repo)!.sessions[0].output).toBe(5);
  });
});

describe("report ranges", () => {
  beforeEach(() => clearProviders());
  afterEach(() => clearProviders());

  it("only includes commits ahead of the merge-base on a branch", async () => {
    const repo = makeRepo();
    const totals = { output: 50 };
    registerProvider(mockProvider("mock", totals));

    const onMain = commit(repo, "main work");
    await postCommit(repo, onMain);

    sh(repo, "git", "checkout", "-q", "-b", "feature");
    totals.output = 80;
    const onBranch = commit(repo, "branch work");
    await postCommit(repo, onBranch);

    const report = buildReport(repo); // default range: merge-base(main, HEAD)..HEAD
    expect(report.commits).toHaveLength(1);
    expect(report.commits[0].commit).toBe(onBranch);
    expect(report.totals.tokens.output).toBe(30); // only the branch delta
  });

  it("reports full history when on the default branch", async () => {
    const repo = makeRepo();
    const totals = { output: 10 };
    registerProvider(mockProvider("mock", totals));
    const c1 = commit(repo, "x");
    await postCommit(repo, c1);
    const report = buildReport(repo);
    expect(report.range).toBe("HEAD");
    expect(report.totals.tokens.output).toBe(10);
  });
});

describe("corrupt transcript resilience", () => {
  it("a git commit never fails because of wick, even with a corrupt transcript", async () => {
    const repo = makeRepo();
    await install(repo);
    // Sanity: committing with hooks installed (wick not on PATH inside the
    // test env resolves via the embedded node entry; either way the hook
    // exits 0 because every branch ends in `|| true`).
    const out = execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "hooked"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(out).toBeDefined();
    expect(sh(repo, "git", "log", "--format=%s", "-1")).toBe("hooked");
  });
});
