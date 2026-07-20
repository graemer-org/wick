import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hooksDir, tryGit } from "./git.js";
import { NOTES_REF } from "./notes.js";

const BEGIN = "# >>> wick >>>";
const END = "# <<< wick <<<";

export const HOOK_EVENTS = [
  "post-commit",
  "post-rewrite",
  "post-merge",
  "pre-push",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Absolute path to this CLI's entry point, embedded in hooks as a fallback so
 * hooks work even when `wick` is not on PATH (e.g. the dogfooding repo).
 */
function cliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "cli.js");
}

/** The shell fragment that locates a runnable wick and invokes it. */
function invoke(args: string, background: boolean): string {
  const entry = cliEntry();
  const run = [
    `if command -v wick >/dev/null 2>&1; then`,
    `  wick ${args} || true`,
    `elif [ -x "./node_modules/.bin/wick" ]; then`,
    `  ./node_modules/.bin/wick ${args} || true`,
    `elif command -v node >/dev/null 2>&1 && [ -f "${entry}" ]; then`,
    `  node "${entry}" ${args} || true`,
    `fi`,
  ].join("\n");
  if (!background) return run;
  return `(\n${run}\n) >/dev/null 2>&1 &`;
}

function blockFor(event: HookEvent): string {
  let body: string;
  switch (event) {
    case "post-commit":
      // Capture the commit hash synchronously, then do the heavy JSONL work
      // detached so the commit isn't blocked.
      body = [
        `WICK_COMMIT="$(git rev-parse HEAD 2>/dev/null)"`,
        invoke(`hook post-commit --commit "$WICK_COMMIT"`, true),
      ].join("\n");
      break;
    case "post-rewrite":
      // stdin carries "<old> <new>" pairs — must be consumed synchronously.
      body = [
        `WICK_PAIRS="$(cat)"`,
        invoke(`hook post-rewrite --pairs "$WICK_PAIRS"`, false),
      ].join("\n");
      break;
    case "post-merge":
      body = invoke("hook post-merge", true);
      break;
    case "pre-push":
      // Ship the wick notes ref alongside, merging with the remote copy if
      // the refs diverged (a plain push would be rejected non-fast-forward
      // and stamps would silently never leave this machine). Skip when the
      // push already includes the notes ref itself — pushing it again from
      // inside the hook races the outer push on the same ref lock.
      body = [
        `WICK_PUSH_REFS="$(cat)"`,
        `case "$WICK_PUSH_REFS" in`,
        `  *"${NOTES_REF}"*) ;;`,
        `  *) if [ -n "$1" ]; then`,
        invoke(`hook pre-push --remote "$1"`, false),
        `  fi ;;`,
        `esac`,
      ].join("\n");
      break;
  }
  return `${BEGIN}\n${body}\n${END}`;
}

function stripBlock(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === BEGIN) {
      inBlock = true;
      continue;
    }
    if (line.trim() === END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) out.push(line);
  }
  return out.join("\n");
}

export interface InstallResult {
  hooksDir: string;
  installed: HookEvent[];
}

/**
 * Chain-safe hook installation: existing hook content (Husky, hand-written)
 * is preserved; wick appends a clearly delimited block. Idempotent — an
 * existing wick block is replaced, not duplicated.
 */
export async function install(cwd: string): Promise<InstallResult> {
  const dir = hooksDir(cwd);
  await fs.mkdir(dir, { recursive: true });

  for (const event of HOOK_EVENTS) {
    const file = path.join(dir, event);
    let existing: string | null = null;
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      // hook doesn't exist yet
    }
    let content: string;
    if (existing === null) {
      content = `#!/bin/sh\n${blockFor(event)}\n`;
    } else {
      const cleaned = stripBlock(existing).replace(/\n+$/, "");
      content = `${cleaned}\n${blockFor(event)}\n`;
    }
    await fs.writeFile(file, content);
    await fs.chmod(file, 0o755);
  }

  // Belt-and-braces: let git itself copy wick notes across rewrites too.
  tryGit(["config", "notes.rewriteRef", NOTES_REF], cwd);

  return { hooksDir: dir, installed: [...HOOK_EVENTS] };
}

/** Remove only wick's delimited blocks; delete hooks that become empty shells. */
export async function uninstall(cwd: string): Promise<void> {
  const dir = hooksDir(cwd);
  for (const event of HOOK_EVENTS) {
    const file = path.join(dir, event);
    let existing: string;
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const cleaned = stripBlock(existing);
    const meaningful = cleaned
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#!"));
    if (meaningful.length === 0) {
      await fs.unlink(file);
    } else {
      await fs.writeFile(file, cleaned);
      await fs.chmod(file, 0o755);
    }
  }
}

export async function hasWickBlock(cwd: string, event: HookEvent): Promise<boolean> {
  try {
    const content = await fs.readFile(path.join(hooksDir(cwd), event), "utf8");
    return content.includes(BEGIN);
  } catch {
    return false;
  }
}
