import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GetUsageOptions,
  ModelUsage,
  SessionRef,
  SessionUsage,
  UsageProvider,
} from "../types.js";

export const PROVIDER_ID = "copilot-cli";

/**
 * GitHub Copilot CLI ("Chronicle") persists one session per directory under
 *   ~/.copilot/session-state/<session-uuid>/
 * with an events.jsonl (one JSON event per line, ISO timestamps). Format
 * observed on-machine (Copilot CLI 1.x, 2026-07):
 *
 *  - session.start   → data.sessionId + data.context.{cwd,gitRoot,repository,branch}
 *  - assistant.message → data.{model,outputTokens} (output only — no input/cache)
 *  - session.shutdown  → data.modelMetrics.<model>.usage
 *                        {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}
 *
 * Newer CLI versions additionally append one row per API call to the central
 * SQLite store ~/.copilot/session-store.db (table assistant_usage_events) —
 * the only complete source while a session is still running.
 *
 * CRITICAL semantics, verified against real data AND the per-request price
 * ledger (token_details_json): `inputTokens` INCLUDES cacheReadTokens, both
 * in the shutdown metrics and in the DB rows. Wick's input class is the
 * non-cached share, so input = inputTokens - cacheReadTokens; treating the
 * inclusive figure as fresh input inflates cost ~10x at Copilot rates.
 *
 * Usage source preference: session.shutdown (closed session, complete)
 * → DB rows (live session, complete on current CLI versions)
 * → assistant.message outputTokens (live session, older CLI — lower bound).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RawCounts {
  input: number; // includes cacheRead — normalized in toModelUsage()
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

function toModelUsage(model: string, c: RawCounts): ModelUsage {
  return {
    model,
    input: Math.max(0, c.input - c.cacheRead),
    cacheRead: c.cacheRead,
    cacheWrite: c.cacheWrite,
    output: c.output,
  };
}

interface ParsedEvents {
  sessionStart: { gitRoot: string | null; cwd: string | null } | null;
  shutdown: Map<string, RawCounts> | null;
  partialOutput: Map<string, number>; // model → summed assistant.message outputTokens
  firstTs: string | null;
  lastTs: string | null;
}

function parseEvents(content: string): ParsedEvents {
  const res: ParsedEvents = {
    sessionStart: null,
    shutdown: null,
    partialOutput: new Map(),
    firstTs: null,
    lastTs: null,
  };
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // corrupt line — skip, never throw
    }
    const ts = typeof e?.timestamp === "string" ? e.timestamp : null;
    if (ts) {
      if (!res.firstTs || ts < res.firstTs) res.firstTs = ts;
      if (!res.lastTs || ts > res.lastTs) res.lastTs = ts;
    }
    if (e?.type === "session.start") {
      const ctx = e.data?.context ?? {};
      res.sessionStart = {
        gitRoot: typeof ctx.gitRoot === "string" ? ctx.gitRoot : null,
        cwd: typeof ctx.cwd === "string" ? ctx.cwd : null,
      };
    } else if (e?.type === "assistant.message") {
      const model = typeof e.data?.model === "string" ? e.data.model : "unknown";
      const out = Number(e.data?.outputTokens) || 0;
      res.partialOutput.set(model, (res.partialOutput.get(model) ?? 0) + out);
    } else if (e?.type === "session.shutdown") {
      const metrics = e.data?.modelMetrics;
      if (metrics && typeof metrics === "object") {
        res.shutdown = new Map();
        for (const [model, m] of Object.entries<any>(metrics)) {
          const u = m?.usage ?? {};
          res.shutdown.set(model, {
            input: Number(u.inputTokens) || 0,
            cacheRead: Number(u.cacheReadTokens) || 0,
            cacheWrite: Number(u.cacheWriteTokens) || 0,
            output: Number(u.outputTokens) || 0,
          });
        }
      }
    }
  }
  return res;
}

/** Head of a file — discovery must not read whole multi-MB event logs. */
async function readHead(file: string, bytes = 65536): Promise<string | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Per-model sums from the central session store via the sqlite3 CLI (no npm
 * dependency; node:sqlite is still flag-gated on Node 22). Returns null when
 * the binary or the DB is unavailable — callers fall back to events.jsonl.
 */
function queryStoreDb(storeDb: string, sessionId: string): Map<string, RawCounts> | null {
  if (!UUID_RE.test(sessionId)) return null;
  let raw: string;
  try {
    raw = execFileSync(
      "sqlite3",
      [
        "-json",
        "-readonly",
        storeDb,
        `SELECT model,
                SUM(input_tokens) AS input,
                SUM(cache_read_tokens) AS cacheRead,
                SUM(cache_write_tokens) AS cacheWrite,
                SUM(output_tokens) AS output
           FROM assistant_usage_events
          WHERE session_id = '${sessionId}'
          GROUP BY model`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
    );
  } catch {
    return null;
  }
  try {
    const rows = raw.trim() ? JSON.parse(raw) : [];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const byModel = new Map<string, RawCounts>();
    for (const r of rows) {
      if (typeof r?.model !== "string") continue;
      byModel.set(r.model, {
        input: Number(r.input) || 0,
        cacheRead: Number(r.cacheRead) || 0,
        cacheWrite: Number(r.cacheWrite) || 0,
        output: Number(r.output) || 0,
      });
    }
    return byModel.size > 0 ? byModel : null;
  } catch {
    return null;
  }
}

export interface CopilotCliProviderOptions {
  /** Override ~/.copilot for tests. */
  copilotDir?: string;
}

export function createCopilotCliProvider(
  opts: CopilotCliProviderOptions = {},
): UsageProvider {
  const copilotDir = opts.copilotDir ?? path.join(os.homedir(), ".copilot");
  const stateDir = path.join(copilotDir, "session-state");
  const storeDb = path.join(copilotDir, "session-store.db");

  return {
    id: PROVIDER_ID,

    async discoverSessions(repoRoot: string): Promise<SessionRef[]> {
      let entries: string[];
      try {
        entries = await fs.readdir(stateDir);
      } catch {
        return []; // no Copilot CLI on this machine — never throw into hooks
      }
      const wanted = path.resolve(repoRoot);
      const refs: SessionRef[] = [];
      for (const entry of entries) {
        if (!UUID_RE.test(entry)) continue;
        const dir = path.join(stateDir, entry);
        const head = await readHead(path.join(dir, "events.jsonl"));
        if (!head) continue;
        // session.start is the first event; parse only the head for discovery.
        const parsed = parseEvents(head.slice(0, head.lastIndexOf("\n") + 1));
        const root = parsed.sessionStart?.gitRoot ?? parsed.sessionStart?.cwd;
        if (!root || path.resolve(root) !== wanted) continue;
        refs.push({ id: entry, provider: PROVIDER_ID, path: dir });
      }
      return refs;
    },

    async getUsage(session: SessionRef, _opts?: GetUsageOptions): Promise<SessionUsage> {
      // No mtime-skip here: a live session's usage can grow in the central
      // session-store.db without touching events.jsonl, so the transcript's
      // mtime is not a reliable "unchanged" signal. `_opts.since` is ignored.
      let content = "";
      try {
        content = await fs.readFile(path.join(session.path, "events.jsonl"), "utf8");
      } catch {
        // missing/unreadable events — DB may still know the session
      }
      const parsed = parseEvents(content);

      let byModel: Map<string, RawCounts> | null = parsed.shutdown;
      if (!byModel) byModel = queryStoreDb(storeDb, session.id);

      const perModel: ModelUsage[] = [];
      if (byModel) {
        for (const [model, counts] of byModel) {
          perModel.push(toModelUsage(model, counts));
        }
      } else {
        // Live session on a CLI without usage-event rows: assistant.message
        // only carries output tokens — a lower bound, completed at shutdown.
        for (const [model, output] of parsed.partialOutput) {
          perModel.push({ model, input: 0, cacheRead: 0, cacheWrite: 0, output });
        }
      }

      return {
        sessionId: session.id,
        provider: PROVIDER_ID,
        perModel,
        firstTs: parsed.firstTs ?? "",
        lastTs: parsed.lastTs ?? "",
      };
    },
  };
}
