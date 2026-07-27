import { describe, expect, it } from "vitest";
import { readAllNotes, writeNote } from "./notes.js";
import { TestFactory } from "./test-factory.js";

/**
 * `readAllNotes` collapses the per-commit `git notes show` loop into two
 * spawns (`git notes list` + one `git cat-file --batch`, #39). These tests
 * pin the behaviours that batched, byte-size parsing must preserve versus the
 * per-commit `readNote` it replaces.
 */
describe("readAllNotes", () => {
  it("returns an empty map when the notes ref does not exist", () => {
    // Arrange — a repo that has never been stamped.
    const repoPath = TestFactory.makeRepo();

    // Act
    const notes = readAllNotes(repoPath);

    // Assert
    expect(notes.size).toBe(0);
  });

  it("reads every stamped commit keyed by commit sha", () => {
    // Arrange — three commits, two of them stamped.
    const repoPath = TestFactory.makeRepo();
    const firstCommit = TestFactory.makeCommit(repoPath, "first");
    const secondCommit = TestFactory.makeCommit(repoPath, "second");
    TestFactory.makeCommit(repoPath, "third-unstamped");
    writeNote(firstCommit, TestFactory.makeSessionNote({ output: 11 }), repoPath);
    writeNote(secondCommit, TestFactory.makeSessionNote({ output: 22 }), repoPath);

    // Act
    const notes = readAllNotes(repoPath);

    // Assert
    expect(notes.size).toBe(2);
    expect(notes.get(firstCommit)!.sessions[0].output).toBe(11);
    expect(notes.get(secondCommit)!.sessions[0].output).toBe(22);
  });

  it("skips a commit whose note is malformed JSON, exactly as readNote treated it", () => {
    // Arrange — one valid note and one hand-written non-JSON note.
    const repoPath = TestFactory.makeRepo();
    const validCommit = TestFactory.makeCommit(repoPath, "valid");
    const malformedCommit = TestFactory.makeCommit(repoPath, "malformed");
    writeNote(validCommit, TestFactory.makeSessionNote({ output: 7 }), repoPath);
    TestFactory.git(
      repoPath,
      "git",
      "notes",
      "--ref=refs/notes/wick",
      "add",
      "-f",
      "-m",
      "not json at all",
      malformedCommit,
    );

    // Act
    const notes = readAllNotes(repoPath);

    // Assert
    expect(notes.has(validCommit)).toBe(true);
    expect(notes.has(malformedCommit)).toBe(false);
  });

  it("parses a note payload whose JSON contains newlines by declared byte size", () => {
    // Arrange — a note whose serialized JSON spans multiple lines, so the
    // cat-file record boundary can only be the byte size, not a line break.
    const repoPath = TestFactory.makeRepo();
    const commit = TestFactory.makeCommit(repoPath, "multiline-note");
    const note = TestFactory.makeSessionNote({ id: "sess-multiline", output: 5 });
    TestFactory.git(
      repoPath,
      "git",
      "notes",
      "--ref=refs/notes/wick",
      "add",
      "-f",
      "-m",
      JSON.stringify(note, null, 2),
      commit,
    );

    // Act
    const notes = readAllNotes(repoPath);

    // Assert
    expect(notes.get(commit)!.sessions[0]).toMatchObject({ id: "sess-multiline", output: 5 });
  });

  it("reads a non-default ref so it can load a diverged source ref for merging", () => {
    // Arrange — a note written onto a separate ref, not refs/notes/wick.
    const repoPath = TestFactory.makeRepo();
    const commit = TestFactory.makeCommit(repoPath, "on-other-ref");
    TestFactory.git(
      repoPath,
      "git",
      "notes",
      "--ref=refs/notes/wick-other",
      "add",
      "-f",
      "-m",
      JSON.stringify(TestFactory.makeSessionNote({ output: 3 })),
      commit,
    );

    // Act
    const onWickRef = readAllNotes(repoPath);
    const onOtherRef = readAllNotes(repoPath, "refs/notes/wick-other");

    // Assert
    expect(onWickRef.size).toBe(0);
    expect(onOtherRef.get(commit)!.sessions[0].output).toBe(3);
  });
});
