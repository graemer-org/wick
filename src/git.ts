import { execFileSync } from "node:child_process";

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/** Absolute path to the repo's git dir (handles worktrees). */
export function gitDir(cwd: string): string {
  return git(["rev-parse", "--absolute-git-dir"], cwd);
}

/**
 * Hooks directory as git itself resolves it — honors core.hooksPath and
 * worktrees (hooks live in the common git dir, not the per-worktree gitdir).
 */
export function hooksDir(cwd: string): string {
  return git(
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    cwd,
  );
}

/**
 * The remote wick should sync notes with: the current branch's configured
 * upstream remote, else `origin`, else the first configured remote, else null
 * (no remote — a purely local repo).
 */
export function notesRemote(cwd: string): string | null {
  const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch && branch !== "HEAD") {
    const upstream = tryGit(["config", `branch.${branch}.remote`], cwd);
    if (upstream) return upstream;
  }
  if (tryGit(["config", "remote.origin.url"], cwd) !== null) return "origin";
  const remotes = tryGit(["remote"], cwd);
  const first = remotes?.split("\n").map((r) => r.trim()).find(Boolean);
  return first ?? null;
}

export function defaultBranch(cwd: string): string | null {
  const originHead = tryGit(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  );
  if (originHead) return originHead; // e.g. "origin/main"
  for (const candidate of ["main", "master"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", candidate], cwd) !== null) {
      return candidate;
    }
  }
  return null;
}
