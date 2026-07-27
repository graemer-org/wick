import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import { writeNote } from "./notes.js";
import { readRollup, ROLLUP_REF, syncRollupFromRemote, syncRollupToRemote, writeRollup } from "./rollup.js";
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

  it("matches the per-commit oracle when the delta adds a new and an existing author", async () => {
    // Arrange — a rollup already folded over one Alice commit.
    const repoPath = TestFactory.makeRepo();
    const alice = { name: "Alice", email: "alice@example.com" };
    const bob = { name: "Bob", email: "bob@example.com" };
    const a1 = TestFactory.makeCommit(repoPath, "alice one", alice);
    writeNote(a1, TestFactory.makeSessionNote({ id: "sA1", model: "claude-opus-4-8", output: 100 }), repoPath);
    await buildReport(repoPath);

    // Act — the incremental delta introduces a brand-new author (Bob) AND a
    // second commit from the already-counted author (Alice); exercises both the
    // create-bucket and merge-into-existing-bucket branches of mergeAggInto.
    const b1 = TestFactory.makeCommit(repoPath, "bob one", bob);
    writeNote(b1, TestFactory.makeSessionNote({ id: "sB1", model: "claude-opus-4-8", output: 300 }), repoPath);
    const a2 = TestFactory.makeCommit(repoPath, "alice two", alice);
    writeNote(a2, TestFactory.makeSessionNote({ id: "sA2", model: "claude-opus-4-8", output: 70 }), repoPath);
    const incremental = await buildReport(repoPath);
    const oracle = await buildReport(repoPath, `${rootCommit(repoPath)}..HEAD`);

    // Assert — the incrementally-built aggregate equals the trusted per-commit
    // report over the same commits (a stronger oracle than a rollup rebuild).
    expect(incremental.totals.tokens).toEqual(oracle.totals.tokens);
    expect(incremental.totals.costUsd).toEqual(oracle.totals.costUsd);
    expect(incremental.totals.sessions).toBe(oracle.totals.sessions);
    expect(authorRows(incremental)).toEqual(authorRows(oracle));
    expect(incremental.authors).toHaveLength(2);
  });

  it("merges an unknown model introduced only in the incremental delta", async () => {
    // Arrange — a rollup over one priced-model commit (real claude-code pricing).
    const repoPath = TestFactory.makeRepo();
    const c1 = TestFactory.makeCommit(repoPath, "priced");
    writeNote(c1, TestFactory.makeSessionNote({ id: "s1", provider: "claude-code", model: "claude-opus-4-8", output: 100 }), repoPath);
    await buildReport(repoPath);

    // Act — the new commit's note uses a model with no pricing.
    const c2 = TestFactory.makeCommit(repoPath, "unpriced");
    writeNote(c2, TestFactory.makeSessionNote({ id: "s2", provider: "claude-code", model: "no-such-model-x", output: 5 }), repoPath);
    const report = await buildReport(repoPath);

    // Assert — the unknown model surfaces, and the priced total stays a lower bound.
    expect(report.unknownModels).toContain("claude-code/no-such-model-x");
    expect(report.totals.costUsd).not.toBeNull();
    expect(report.totals.costUsd).toBeGreaterThan(0);
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

  it("recomputes when an old commit's note changes AND HEAD advances in the same run", async () => {
    // Arrange — two stamped commits, rollup built.
    const repoPath = TestFactory.makeRepo();
    const first = TestFactory.makeCommit(repoPath, "first");
    writeNote(first, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 100 }), repoPath);
    TestFactory.makeCommit(repoPath, "second");
    writeNote(TestFactory.git(repoPath, "git", "rev-parse", "HEAD"), TestFactory.makeSessionNote({ id: "s2", model: "claude-opus-4-8", output: 100 }), repoPath);
    await buildReport(repoPath);

    // Act — HEAD advances (a new stamped commit) WHILE an already-counted
    // commit's note also changes. The changed old note is outside the new
    // range, so the `touchesCounted` guard must force a recompute, not an
    // incremental fold that would trust the stale first-commit total.
    const third = TestFactory.makeCommit(repoPath, "third");
    writeNote(third, TestFactory.makeSessionNote({ id: "s3", model: "claude-opus-4-8", output: 50 }), repoPath);
    writeNote(first, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 999 }), repoPath);
    const report = await buildReport(repoPath);

    // Assert — every current note is reflected (999 + 100 + 50), not a stale sum.
    expect(report.totals.tokens.output).toBe(1149);
    expect(report.totals.stampedCommits).toBe(3);
  });

  it("recomputes to empty when the notes ref is deleted after a rollup exists", async () => {
    // Arrange — a stamped repo whose rollup is built.
    const repoPath = TestFactory.makeRepo();
    const c = TestFactory.makeCommit(repoPath, "work");
    writeNote(c, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 100 }), repoPath);
    await buildReport(repoPath);

    // Act — the entire notes ref disappears (notes === null at report time).
    TestFactory.git(repoPath, "git", "update-ref", "-d", "refs/notes/wick");
    const report = await buildReport(repoPath);

    // Assert — the stale note contribution is dropped, not carried forward.
    expect(report.totals.stampedCommits).toBe(0);
    expect(report.totals.tokens.output).toBe(0);
  });

  it("recomputes (never serves a stale total) when the prior notes state can't be diffed", async () => {
    // Arrange — two stamped commits, rollup built at the real notes tip.
    const repoPath = TestFactory.makeRepo();
    const first = TestFactory.makeCommit(repoPath, "first");
    writeNote(first, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 100 }), repoPath);
    const second = TestFactory.makeCommit(repoPath, "second");
    writeNote(second, TestFactory.makeSessionNote({ id: "s2", model: "claude-opus-4-8", output: 200 }), repoPath);
    await buildReport(repoPath);

    // Point the cached rollup's `notes` at a sha that isn't in the object store
    // (as if adopted from a remote whose notes history was pruned), so the
    // incremental notes-diff will fail — while an already-counted commit's note
    // changes underneath. HEAD is unchanged, so only the diff decides the path.
    const rollup = readRollup(repoPath)!;
    rollup.notes = "0000000000000000000000000000000000000000";
    writeRollup(repoPath, rollup);
    writeNote(first, TestFactory.makeSessionNote({ id: "s1", model: "claude-opus-4-8", output: 999 }), repoPath);

    // Act
    const report = await buildReport(repoPath);

    // Assert — a failed diff must recompute (999 + 200), not fold incrementally
    // over an unverified aggregate and re-cache the stale 300 under the new key.
    expect(report.totals.tokens.output).toBe(1199);
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
