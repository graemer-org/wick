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

/** A deterministic, gently silly comparison for a dollar amount. */
export function costFlavor(c: number | null): string | null {
  if (c === null) return null;
  if (c === 0) return "barely singed the wick 🕯️";
  if (c < 1) return "cheaper than a gumball 🍬";
  if (c < 5) return "about one fancy latte ☕";
  if (c < 20) return "a solid lunch 🌯";
  if (c < 75) return "a nice dinner for two 🍝";
  if (c < 250) return "a AAA game plus the DLC 🎮";
  return "somebody's GPU bill 🔥";
}

export interface RenderOptions {
  /** Emit ANSI colors. Default false — the CLI enables it on a TTY. */
  color?: boolean;
}

const totalTokens = (t: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}) => t.input + t.cacheRead + t.cacheWrite + t.output;

export function renderReport(report: Report, opts: RenderOptions = {}): string {
  const on = opts.color === true;
  const paint = (code: string, s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = (s: string) => paint("1", s);
  const dim = (s: string) => paint("2", s);
  const yellow = (s: string) => paint("33", s);
  const green = (s: string) => paint("32", s);
  const cyan = (s: string) => paint("36", s);
  const magenta = (s: string) => paint("35", s);
  const red = (s: string) => paint("31", s);

  // Per-commit burn bar: share of the range's tokens, heat-colored.
  const BAR_W = 10;
  const maxTok = Math.max(1, ...report.commits.map((c) => totalTokens(c.tokens)));
  const burnBar = (tok: number): string => {
    const share = tok / maxTok;
    const filled = Math.max(1, Math.round(share * BAR_W));
    const bar = "█".repeat(filled) + dim("░".repeat(BAR_W - filled));
    return share > 0.66 ? red(bar) : share > 0.33 ? yellow(bar) : green(bar);
  };

  const lines: string[] = [];
  lines.push(`${bold("🕯️ wick report")} ${dim(`— ${report.range}`)}`);
  lines.push("");

  if (report.commits.length === 0) {
    lines.push(dim("no stamped commits in range — light a session and commit something 🕯️"));
  } else {
    const header = ["commit", "burn", "sess", "input", "cache-r", "cache-w", "output", "cost", "subject"];
    const plainRows = report.commits.map((c) => [
      c.commit.slice(0, 8),
      "".padEnd(BAR_W), // width placeholder; painted below
      String(c.sessions.length),
      fmtTokens(c.tokens.input),
      fmtTokens(c.tokens.cacheRead),
      fmtTokens(c.tokens.cacheWrite),
      fmtTokens(c.tokens.output),
      fmtCost(c.costUsd),
      c.subject.length > 40 ? `${c.subject.slice(0, 37)}...` : c.subject,
    ]);
    const widths = header.map((h, i) =>
      Math.max(h.length, ...plainRows.map((r) => r[i].length)),
    );
    lines.push(
      bold(header.map((h, i) => h.padEnd(widths[i])).join("  ").trimEnd()),
    );
    report.commits.forEach((c, rowIdx) => {
      const r = plainRows[rowIdx];
      const cells = [
        yellow(r[0].padEnd(widths[0])),
        burnBar(totalTokens(c.tokens)),
        dim(r[2].padEnd(widths[2])),
        r[3].padEnd(widths[3]),
        cyan(r[4].padEnd(widths[4])),
        r[5].padEnd(widths[5]),
        magenta(r[6].padEnd(widths[6])),
        green(bold(r[7].padEnd(widths[7]))),
        r[8],
      ];
      lines.push(cells.join("  ").trimEnd());
    });
  }

  const t = report.totals;
  lines.push("");
  lines.push(
    `💰 ${bold(`total ${fmtCost(t.costUsd)}`)} — ` +
      `${bold(fmtTokens(totalTokens(t.tokens)))} tokens across ` +
      `${t.sessions} session${t.sessions === 1 ? "" : "s"} · ` +
      `${t.stampedCommits}/${t.commits} commits stamped`,
  );
  lines.push(
    dim(
      `   input ${fmtTokens(t.tokens.input)} · cache read ${fmtTokens(t.tokens.cacheRead)} · ` +
        `cache write ${fmtTokens(t.tokens.cacheWrite)} · output ${fmtTokens(t.tokens.output)}`,
    ),
  );
  const flavor = costFlavor(t.costUsd);
  if (flavor && t.stampedCommits > 0) {
    lines.push(dim(`   ≈ ${flavor}`));
  }

  if (report.authors.length > 0) {
    lines.push("");
    lines.push(bold("👥 by author"));
    const nameCounts = new Map<string, number>();
    for (const a of report.authors) {
      nameCounts.set(a.author, (nameCounts.get(a.author) ?? 0) + 1);
    }
    const aRows = report.authors.map((a) => [
      // Same name under multiple unmapped emails — show the email to
      // disambiguate (fix properly with a .mailmap).
      `   ${(nameCounts.get(a.author) ?? 0) > 1 ? `${a.author} <${a.authorEmail}>` : a.author}`,
      `${a.stampedCommits} commit${a.stampedCommits === 1 ? "" : "s"}`,
      `${a.sessions} session${a.sessions === 1 ? "" : "s"}`,
      `${fmtTokens(totalTokens(a.tokens))} tokens`,
      fmtCost(a.costUsd),
    ]);
    const aWidths = aRows[0].map((_, i) =>
      Math.max(...aRows.map((r) => r[i].length)),
    );
    for (const r of aRows) {
      const cells = r.map((cell, i) => cell.padEnd(aWidths[i]));
      cells[4] = green(bold(cells[4]));
      lines.push(cells.join("  ").trimEnd());
    }
  }
  if (report.unknownModels.length > 0) {
    lines.push(
      yellow(
        `⚠️  no pricing for ${report.unknownModels.join(", ")} — cost shown is a lower bound`,
      ),
    );
  }
  return lines.join("\n");
}
