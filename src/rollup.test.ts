import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import { writeNote } from "./notes.js";
import { readRollup, ROLLUP_REF, syncRollupFromRemote, syncRollupToRemote } from "./rollup.js";
import { TestFactory } from "./test-factory.js";

/**
 * The full-history report (`range === "HEAD"`) is served from the incremental
 * rollup, not the per-commit walk. Its totals + by-author MUST equal what the
 * trusted per-commit path produces over the same stamped commits — that
 * equivalence (a bounded range covering all commits) is the oracle these tests
 * lean on, so pricing/aggregation stay in one place.
 */

/** The repo's root (parentless) commit — `root..HEAD` is every later commit. */
function rootCommit(repoPath: string): string {
  return TestFactory.git(repoPath, "git", "rev-list", "--max-parents=0", "HEAD");
}

/** Normalize authors to a comparable, order-independent shape. */
function authorRows(report: { authors: Array<Record<string, unknown>> }) {
  return [...report.authors]
    .map((a) => ({ ...a }))
    .sort((x, y) => String(x.authorEmail).localeCompare(String(y.authorEmail)));
}

describe("full-history rollup matches the per-commit report", () => {
  it("aggregates totals, by-author, sessions and unknown models identically", async () => {
    // Arrange — several stamped commits: two authors, a shared session spanning
    // two commits, a priced model and an unknown one.
    const repoPath = TestFactory.makeRepo();
    const alice = { name: "Alice", email: "alice@example.com" };
    const bob = { name: "Bob", email: "bob@example.com" };
    const c1 = TestFactory.makeCommit(repoPath, "alice one", alice);
    writeNote(c1, TestFactory.makeSessionNote({ id: "sA", model: "claude-opus-4-8", input: 100, output: 200 }), repoPath);
    const c2 = TestFactory.makeCommit(repoPath, "bob one", bob);
    writeNote(c2, TestFactory.makeSessionNote({ id: "sB", model: "claude-opus-4-8", input: 50, cacheRead: 300, output: 100 }), repoPath);
    const c3 = TestFactory.makeCommit(repoPath, "alice two", alice);
    writeNote(
      c3,
      TestFactory.makeNote([
        TestFactory.makeSession({ id: "sA", model: "claude-opus-4-8", output: 50 }), // same session as c1
        TestFactory.makeSession({ id: "sC", model: "totally-unknown-model", output: 1000 }),
      ]),
      repoPath,
    );

    // Act — full history (rollup) vs a bounded range over the very same commits.
    const rollup = await buildReport(repoPath);
    const perCommit = await buildReport(repoPath, `${rootCommit(repoPath)}..HEAD`);

    // Assert — the aggregate halves are identical; only the per-commit rows differ.
    expect(rollup.omittedCommitRows).toBe(true);
    expect(rollup.commits).toEqual([]);
    expect(rollup.totals.tokens).toEqual(perCommit.totals.tokens);
    expect(rollup.totals.costUsd).toEqual(perCommit.totals.costUsd);
    expect(rollup.totals.stampedCommits).toBe(perCommit.totals.stampedCommits);
    expect(rollup.totals.sessions).toBe(perCommit.totals.sessions);
    expect(rollup.unknownModels).toEqual(perCommit.unknownModels);
    expect(authorRows(rollup)).toEqual(authorRows(perCommit));
    // Concrete: the shared session sA is counted once across c1 and c3.
    expect(rollup.totals.sessions).toBe(3); // sA, sB, sC
    expect(rollup.totals.stampedCommits).toBe(3);
  });
});

describe("rollup incremental update", () => {
  it("equals a from-scratch rebuild after HEAD advances", async () => {
    // Arrange — a stamped repo whose rollup is already built once.
    const repoPath = TestFactory.makeRepo();
    const first = TestFactory.makeCommit(repoPath, "first");
    writeNote(first, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 100 }), repoPath);
    await buildReport(repoPath); // builds + persists the rollup at this HEAD

    // Act — advance HEAD with a new stamped commit, then update incrementally.
    const second = TestFactory.makeCommit(repoPath, "second");
    writeNote(second, TestFactory.makeSessionNote({ id: "s2", model: "claude-opus-4-8", output: 250 }), repoPath);
    const incremental = await buildReport(repoPath);

    // Rebuild from scratch by dropping the cached ref.
    TestFactory.git(repoPath, "git", "update-ref", "-d", ROLLUP_REF);
    const fromScratch = await buildReport(repoPath);

    // Assert — the incrementally-updated aggregate matches the cold rebuild.
    expect(incremental.totals).toEqual(fromScratch.totals);
    expect(authorRows(incremental)).toEqual(authorRows(fromScratch));
    expect(incremental.totals.stampedCommits).toBe(2);
  });

  it("counts a session spanning the incremental boundary exactly once", async () => {
    // Arrange — session s1 stamped on the first commit, rollup built.
    const repoPath = TestFactory.makeRepo();
    const first = TestFactory.makeCommit(repoPath, "first");
    writeNote(first, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 100 }), repoPath);
    await buildReport(repoPath);

    // Act — the SAME session id appears again on a new commit (its delta).
    const second = TestFactory.makeCommit(repoPath, "second");
    writeNote(second, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 40 }), repoPath);
    const report = await buildReport(repoPath);

    // Assert — one unique session, both commits stamped, tokens summed.
    expect(report.totals.sessions).toBe(1);
    expect(report.totals.stampedCommits).toBe(2);
    expect(report.totals.tokens.output).toBe(140);
  });

  it("recomputes when an already-counted commit's note changes", async () => {
    // Arrange — two commits stamped, rollup built.
    const repoPath = TestFactory.makeRepo();
    const first = TestFactory.makeCommit(repoPath, "first");
    writeNote(first, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 100 }), repoPath);
    const second = TestFactory.makeCommit(repoPath, "second");
    writeNote(second, TestFactory.makeSessionNote({ id: "s2", model: "claude-opus-4-8", output: 100 }), repoPath);
    await buildReport(repoPath);

    // Act — retroactively grow the FIRST (already-counted) commit's note. HEAD
    // did not move, so this must trip the recompute fallback, not incremental.
    writeNote(first, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 999 }), repoPath);
    const report = await buildReport(repoPath);

    // Assert — the changed note is reflected (no stale cached total).
    expect(report.totals.tokens.output).toBe(1099);
  });

  it("recomputes when history is rewritten (non-fast-forward)", async () => {
    // Arrange — three stamped commits, rollup built over all of them.
    const repoPath = TestFactory.makeRepo();
    const first = TestFactory.makeCommit(repoPath, "first");
    writeNote(first, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 100 }), repoPath);
    TestFactory.makeCommit(repoPath, "second");
    const third = TestFactory.makeCommit(repoPath, "third");
    writeNote(third, TestFactory.makeSessionNote({ id: "s3", model: "claude-opus-4-8", output: 300 }), repoPath);
    await buildReport(repoPath);

    // Act — reset HEAD back to `first` (third is no longer reachable).
    TestFactory.git(repoPath, "git", "reset", "--hard", first);
    const report = await buildReport(repoPath);

    // Assert — only the still-reachable stamp counts; the orphaned one is gone.
    expect(report.totals.stampedCommits).toBe(1);
    expect(report.totals.tokens.output).toBe(100);
  });
});

describe("rollup ref persistence and sync", () => {
  it("round-trips the aggregate through the ref blob", async () => {
    // Arrange
    const repoPath = TestFactory.makeRepo();
    const c = TestFactory.makeCommit(repoPath, "work");
    writeNote(c, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", input: 7, output: 11 }), repoPath);

    // Act — building persists the rollup; read it straight back.
    await buildReport(repoPath);
    const rollup = readRollup(repoPath);

    // Assert
    expect(rollup).not.toBeNull();
    expect(rollup!.agg.stampedCommits).toBe(1);
    expect(rollup!.agg.sessions.has("provider-1:s1")).toBe(true);
  });

  it("lets a fresh clone read the pushed rollup instead of rebuilding it", async () => {
    // Arrange — a stamped repo whose rollup is pushed to a bare remote.
    const repoPath = TestFactory.makeRepo();
    const c = TestFactory.makeCommit(repoPath, "work");
    writeNote(c, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 42 }), repoPath);
    const remotePath = TestFactory.addBareRemote(repoPath);
    await buildReport(repoPath);
    expect(syncRollupToRemote("origin", repoPath)).toBe("pushed");

    // Act — a fresh clone (no local rollup) adopts the remote one. The rollup
    // blob is self-contained, so the clone reads the aggregate without ever
    // fetching notes or folding history itself.
    const clonePath = TestFactory.cloneRepo(remotePath);
    const status = syncRollupFromRemote("origin", clonePath);

    // Assert — the clone has the aggregate without ever folding history itself.
    expect(status).toBe("updated");
    const adopted = readRollup(clonePath);
    expect(adopted!.agg.stampedCommits).toBe(1);
    expect(adopted!.agg.perModel.size).toBeGreaterThan(0);
  });

  it("never clobbers a local rollup on fetch", async () => {
    // Arrange — both repos have their own local rollup.
    const repoPath = TestFactory.makeRepo();
    const c = TestFactory.makeCommit(repoPath, "work");
    writeNote(c, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 10 }), repoPath);
    TestFactory.addBareRemote(repoPath);
    await buildReport(repoPath);
    syncRollupToRemote("origin", repoPath);
    const localSha = TestFactory.git(repoPath, "git", "rev-parse", ROLLUP_REF);

    // Act — a fetch when a local rollup already exists must keep it.
    const status = syncRollupFromRemote("origin", repoPath);

    // Assert
    expect(status).toBe("up-to-date");
    expect(TestFactory.git(repoPath, "git", "rev-parse", ROLLUP_REF)).toBe(localSha);
  });
});
