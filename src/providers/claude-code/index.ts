import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ModelUsage,
  SessionRef,
  SessionUsage,
  TimeWindow,
  UsageProvider,
} from "../types.js";

export const PROVIDER_ID = "claude-code";

/**
 * Claude Code stores one JSONL transcript per session under
 *   ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
 * where the project path is encoded by replacing every character that is not
 * [a-zA-Z0-9] with "-". Subagent transcripts live under
 *   <encoded-project-path>/<session-id>/subagents/agent-*.jsonl
 * and are attributed to the parent session.
 *
 * Format observed on-machine (Claude Code 2.x): each line is a JSON object;
 * assistant records have { type: "assistant", timestamp, sessionId, cwd,
 * message: { id, model, usage: { input_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens, output_tokens } } }.
 *
 * The same streaming assistant message is snapshotted multiple times, so we
 * dedupe by message.id keeping the LAST occurrence.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MessageUsage {
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  ts: string | null;
}

function parseAssistantLine(line: string): { id: string; u: MessageUsage } | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // corrupt line — skip, never throw
  }
  if (!obj || obj.type !== "assistant" || !obj.message) return null;
  const msg = obj.message;
  const usage = msg.usage;
  if (!msg.id || !usage) return null;
  return {
    id: msg.id,
    u: {
      model: typeof msg.model === "string" ? msg.model : "unknown",
      input: Number(usage.input_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
      cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
      output: Number(usage.output_tokens) || 0,
      ts: typeof obj.timestamp === "string" ? obj.timestamp : null,
    },
  };
}

async function parseTranscriptFile(
  file: string,
  byMessageId: Map<string, MessageUsage>,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseAssistantLine(line);
    if (parsed) byMessageId.set(parsed.id, parsed.u); // last occurrence wins
  }
}

function inWindow(ts: string | null, window?: TimeWindow): boolean {
  if (!window || !ts) return true;
  if (window.start && ts < window.start) return false;
  if (window.end && ts > window.end) return false;
  return true;
}

export interface ClaudeCodeProviderOptions {
  /** Override ~/.claude for tests. */
  claudeDir?: string;
}

export function createClaudeCodeProvider(
  opts: ClaudeCodeProviderOptions = {},
): UsageProvider {
  const claudeDir = opts.claudeDir ?? path.join(os.homedir(), ".claude");

  return {
    id: PROVIDER_ID,

    async discoverSessions(repoRoot: string, _window: TimeWindow): Promise<SessionRef[]> {
      const projectDir = path.join(
        claudeDir,
        "projects",
        encodeProjectPath(repoRoot),
      );
      let entries: string[];
      try {
        entries = await fs.readdir(projectDir);
      } catch {
        return []; // no transcripts for this repo — never throw into hooks
      }
      const refs: SessionRef[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const sessionId = entry.slice(0, -".jsonl".length);
        if (!UUID_RE.test(sessionId)) continue; // skip *.ccr-tip.json etc.
        refs.push({
          id: sessionId,
          provider: PROVIDER_ID,
          path: path.join(projectDir, entry),
        });
      }
      return refs;
    },

    async getUsage(session: SessionRef, window?: TimeWindow): Promise<SessionUsage> {
      const byMessageId = new Map<string, MessageUsage>();
      await parseTranscriptFile(session.path, byMessageId);

      // Subagent transcripts: <dir>/<session-id>/subagents/*.jsonl
      const subagentsDir = path.join(
        path.dirname(session.path),
        session.id,
        "subagents",
      );
      try {
        for (const f of await fs.readdir(subagentsDir)) {
          if (f.endsWith(".jsonl")) {
            await parseTranscriptFile(path.join(subagentsDir, f), byMessageId);
          }
        }
      } catch {
        // no subagents — fine
      }

      const perModel = new Map<string, ModelUsage>();
      let firstTs: string | null = null;
      let lastTs: string | null = null;
      for (const u of byMessageId.values()) {
        if (!inWindow(u.ts, window)) continue;
        const agg = perModel.get(u.model) ?? {
          model: u.model,
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
        };
        agg.input += u.input;
        agg.cacheRead += u.cacheRead;
        agg.cacheWrite += u.cacheWrite;
        agg.output += u.output;
        perModel.set(u.model, agg);
        if (u.ts) {
          if (!firstTs || u.ts < firstTs) firstTs = u.ts;
          if (!lastTs || u.ts > lastTs) lastTs = u.ts;
        }
      }

      return {
        sessionId: session.id,
        provider: PROVIDER_ID,
        perModel: [...perModel.values()],
        firstTs: firstTs ?? "",
        lastTs: lastTs ?? "",
      };
    },
  };
}
