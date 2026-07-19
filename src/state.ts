import { promises as fs } from "node:fs";
import * as path from "node:path";
import { emptyState, type StampState } from "./attribution.js";
import { gitDir } from "./git.js";

/**
 * Local (never committed) bookkeeping lives under .git/wick/:
 *   state.json — per-session cumulative baselines as of the last stamp
 *   lock/      — mkdir-based mutex serializing concurrent hook runs
 */

function wickDir(cwd: string): string {
  return path.join(gitDir(cwd), "wick");
}

export function statePath(cwd: string): string {
  return path.join(wickDir(cwd), "state.json");
}

export async function loadState(cwd: string): Promise<StampState> {
  try {
    const raw = await fs.readFile(statePath(cwd), "utf8");
    const data = JSON.parse(raw);
    if (data && data.v === 1) return data;
  } catch {
    // missing or corrupt — start fresh
  }
  return emptyState();
}

export async function saveState(cwd: string, state: StampState): Promise<void> {
  const dir = wickDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `state.json.tmp.${process.pid}`);
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, statePath(cwd));
}

const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

export async function withLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = path.join(wickDir(cwd), "lock");
  await fs.mkdir(wickDir(cwd), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch {
      // Break stale locks left by killed processes.
      try {
        const st = await fs.stat(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(lockDir).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished — retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error("wick: timed out waiting for state lock");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lockDir).catch(() => {});
  }
}
