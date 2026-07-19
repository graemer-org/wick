import { execFileSync } from "node:child_process";
import { mergeNotes, type NoteData } from "./attribution.js";

export const NOTES_REF = "refs/notes/wick";

function gitNotes(args: string[], cwd: string): string {
  return execFileSync("git", ["notes", `--ref=${NOTES_REF}`, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

export function readNote(commit: string, cwd: string): NoteData | null {
  let raw: string;
  try {
    raw = gitNotes(["show", commit], cwd);
  } catch {
    return null; // no note on this commit
  }
  try {
    const data = JSON.parse(raw);
    if (data && data.v === 1 && Array.isArray(data.sessions)) return data;
  } catch {
    // malformed note — treat as absent
  }
  return null;
}

export function writeNote(commit: string, data: NoteData, cwd: string): void {
  gitNotes(["add", "-f", "-m", JSON.stringify(data), commit], cwd);
}

/** Merge `data` into whatever note already exists on `commit`. */
export function upsertNote(commit: string, data: NoteData, cwd: string): void {
  const existing = readNote(commit, cwd);
  writeNote(commit, existing ? mergeNotes(existing, data) : data, cwd);
}

/** Copy/merge the note from oldCommit onto newCommit (post-rewrite remapping). */
export function remapNote(oldCommit: string, newCommit: string, cwd: string): void {
  const oldNote = readNote(oldCommit, cwd);
  if (!oldNote) return;
  const newNote = readNote(newCommit, cwd);
  // If git's own notes.rewriteRef copying already moved the identical note,
  // merging would double it — only merge when the new note differs.
  if (newNote && JSON.stringify(newNote) === JSON.stringify(oldNote)) return;
  writeNote(newCommit, newNote ? mergeNotes(newNote, oldNote) : oldNote, cwd);
}
