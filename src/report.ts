import { defaultBranch, git, repoRoot, tryGit } from "./git.js";
import { readNote } from "./notes.js";
import { costUsd, loadPricing } from "./pricing.js";

export interface CommitReport {
  commit: string;
  subject: string;
  author: string;
  authorEmail: string;
  sessions: string[];
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
  /** null when at least one model had no pricing (cost is then a lower bound). */
  costUsd: number | null;
}

export interface AuthorReport {
  author: string;
  authorEmail: string;
  stampedCommits: number;
  sessions: number;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
  costUsd: number | null;
}

export interface Report {
  range: string;
  commits: CommitReport[];
  authors: AuthorReport[];
  totals: {
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
    costUsd: number | null;
    sessions: number;
    stampedCommits: number;
    commits: number;
  };
  unknownModels: string[];
}

/**
 * Resolve the commit range to report on.
 * - explicit range argument wins;
 * - on a feature branch: merge-base with the default branch → HEAD;
 * - on the default branch itself (or no default): full history of HEAD.
 */
export function resolveRange(cwd: string, explicit?: string): string {
  if (explicit) return explicit;
  const def = defaultBranch(cwd);
  if (def) {
    const mergeBase = tryGit(["merge-base", def, "HEAD"], cwd);
    const head = tryGit(["rev-parse", "HEAD"], cwd);
    if (mergeBase && head && mergeBase !== head) {
      return `${mergeBase}..HEAD`;
    }
  }
  return "HEAD";
}

export function buildReport(cwd: string, rangeArg?: string): Report {
  const root = repoRoot(cwd);
  const range = resolveRange(root, rangeArg);
  const pricing = loadPricing(root);

  // %aN/%aE respect .mailmap, so repos can unify author identities (e.g.
  // GitHub squash commits carry the account's primary email while local
  // commits use the noreply address).
  const list = tryGit(
    ["log", "--format=%H%x09%aN%x09%aE%x09%s", ...range.split(/\s+/)],
    root,
  );
  const commits: CommitReport[] = [];
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const allSessions = new Set<string>();
  const unknownModels = new Set<string>();
  let totalCost = 0;
  let sawUnknown = false;
  let stampedCommits = 0;
  let commitCount = 0;

  interface AuthorAgg {
    author: string;
    authorEmail: string;
    stampedCommits: number;
    sessions: Set<string>;
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
    cost: number;
    unknown: boolean;
  }
  const byAuthor = new Map<string, AuthorAgg>();

  for (const line of (list ?? "").split("\n")) {
    if (!line.trim()) continue;
    commitCount++;
    const [sha, author = "", authorEmail = "", subject = ""] = line.split("\t");
    const note = readNote(sha, root);
    if (!note) continue;
    stampedCommits++;

    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const sessions = new Set<string>();
    let commitCost = 0;
    let commitUnknown = false;
    for (const s of note.sessions) {
      sessions.add(s.id);
      allSessions.add(`${s.provider}:${s.id}`);
      tokens.input += s.input;
      tokens.cacheRead += s.cacheRead;
      tokens.cacheWrite += s.cacheWrite;
      tokens.output += s.output;
      const c = costUsd(pricing, s.provider, s.model, s);
      if (c === null) {
        commitUnknown = true;
        sawUnknown = true;
        unknownModels.add(`${s.provider}/${s.model}`);
      } else {
        commitCost += c;
      }
    }
    totals.input += tokens.input;
    totals.cacheRead += tokens.cacheRead;
    totals.cacheWrite += tokens.cacheWrite;
    totals.output += tokens.output;
    totalCost += commitCost;

    const authorKey = authorEmail || author;
    const agg = byAuthor.get(authorKey) ?? {
      author,
      authorEmail,
      stampedCommits: 0,
      sessions: new Set<string>(),
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      cost: 0,
      unknown: false,
    };
    agg.stampedCommits++;
    for (const s of sessions) agg.sessions.add(s);
    agg.tokens.input += tokens.input;
    agg.tokens.cacheRead += tokens.cacheRead;
    agg.tokens.cacheWrite += tokens.cacheWrite;
    agg.tokens.output += tokens.output;
    agg.cost += commitCost;
    agg.unknown ||= commitUnknown;
    byAuthor.set(authorKey, agg);

    commits.push({
      commit: sha,
      subject,
      author,
      authorEmail,
      sessions: [...sessions],
      tokens,
      costUsd: commitUnknown ? null : commitCost,
    });
  }

  const authors: AuthorReport[] = [...byAuthor.values()]
    .map((a) => ({
      author: a.author,
      authorEmail: a.authorEmail,
      stampedCommits: a.stampedCommits,
      sessions: a.sessions.size,
      tokens: a.tokens,
      costUsd: a.unknown && a.cost === 0 ? null : a.cost,
    }))
    .sort((x, y) => (y.costUsd ?? 0) - (x.costUsd ?? 0));

  return {
    range,
    commits,
    authors,
    totals: {
      tokens: totals,
      costUsd: sawUnknown && totalCost === 0 ? null : totalCost,
      sessions: allSessions.size,
      stampedCommits,
      commits: commitCount,
    },
    unknownModels: [...unknownModels],
  };
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(c: number | null): string {
  return c === null ? "n/a" : `$${c.toFixed(2)}`;
}

export function renderReport(report: Report): string {
  const lines: string[] = [];
  const rows = report.commits.map((c) => [
    c.commit.slice(0, 8),
    String(c.sessions.length),
    fmtTokens(c.tokens.input),
    fmtTokens(c.tokens.cacheRead),
    fmtTokens(c.tokens.cacheWrite),
    fmtTokens(c.tokens.output),
    fmtCost(c.costUsd),
    c.subject.length > 44 ? `${c.subject.slice(0, 41)}...` : c.subject,
  ]);
  const header = ["commit", "sess", "input", "cache-r", "cache-w", "output", "cost", "subject"];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmtRow = (r: string[]) =>
    r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();

  lines.push(`range: ${report.range}`);
  lines.push("");
  if (rows.length === 0) {
    lines.push("no stamped commits in range");
  } else {
    lines.push(fmtRow(header));
    for (const r of rows) lines.push(fmtRow(r));
  }
  const t = report.totals;
  lines.push("");
  lines.push(
    `\x1b[1mtotal ${fmtCost(t.costUsd)}\x1b[0m — ` +
      `${fmtTokens(t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.output)} tokens ` +
      `across ${t.sessions} session${t.sessions === 1 ? "" : "s"} · ` +
      `${t.stampedCommits}/${t.commits} commits stamped ` +
      `(input ${fmtTokens(t.tokens.input)} · cache read ${fmtTokens(t.tokens.cacheRead)} · ` +
      `cache write ${fmtTokens(t.tokens.cacheWrite)} · output ${fmtTokens(t.tokens.output)})`,
  );
  if (report.authors.length > 0) {
    lines.push("");
    lines.push("by author:");
    const nameCounts = new Map<string, number>();
    for (const a of report.authors) {
      nameCounts.set(a.author, (nameCounts.get(a.author) ?? 0) + 1);
    }
    const aRows = report.authors.map((a) => [
      // Same name under multiple unmapped emails — show the email to
      // disambiguate (fix properly with a .mailmap).
      `  ${(nameCounts.get(a.author) ?? 0) > 1 ? `${a.author} <${a.authorEmail}>` : a.author}`,
      `${a.stampedCommits} commit${a.stampedCommits === 1 ? "" : "s"}`,
      `${a.sessions} session${a.sessions === 1 ? "" : "s"}`,
      fmtTokens(
        a.tokens.input + a.tokens.cacheRead + a.tokens.cacheWrite + a.tokens.output,
      ) + " tokens",
      fmtCost(a.costUsd),
    ]);
    const aWidths = aRows[0].map((_, i) =>
      Math.max(...aRows.map((r) => r[i].length)),
    );
    for (const r of aRows) {
      lines.push(r.map((cell, i) => cell.padEnd(aWidths[i])).join("  ").trimEnd());
    }
  }
  if (report.unknownModels.length > 0) {
    lines.push(
      `note: no pricing for ${report.unknownModels.join(", ")} — cost shown is a lower bound`,
    );
  }
  return lines.join("\n");
}
