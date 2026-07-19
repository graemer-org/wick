#!/usr/bin/env node
/**
 * Upsert the sticky Wick PR comment from a `wick report --json` file.
 * Finds an existing comment by the hidden marker and edits it in place
 * instead of stacking new comments.
 *
 * Env: GITHUB_TOKEN, REPO ("owner/name"), PR_NUMBER.
 * Set WICK_DRY_RUN=1 to print the rendered comment instead of posting.
 */
import { readFileSync } from "node:fs";

const MARKER = "<!-- wick-report -->";

const [, , reportPath] = process.argv;
const report = JSON.parse(readFileSync(reportPath, "utf8"));

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(c) {
  return c === null ? "n/a" : `$${c.toFixed(2)}`;
}

// Keep in sync with costFlavor() in src/report.ts.
function costFlavor(c) {
  if (c === null) return null;
  if (c === 0) return "barely singed the wick 🕯️";
  if (c < 1) return "cheaper than a gumball 🍬";
  if (c < 5) return "about one fancy latte ☕";
  if (c < 20) return "a solid lunch 🌯";
  if (c < 75) return "a nice dinner for two 🍝";
  if (c < 250) return "a AAA game plus the DLC 🎮";
  return "somebody's GPU bill 🔥";
}

const sumTok = (t) => t.input + t.cacheRead + t.cacheWrite + t.output;

const t = report.totals;
const cost = fmtCost(t.costUsd);

const authorLines =
  (report.authors?.length ?? 0) > 1
    ? [
        "👥 **by author:** " +
          report.authors
            .map((a) => `${a.author} **${fmtCost(a.costUsd)}**`)
            .join(" · "),
        "",
      ]
    : [];

const stamped = report.commits ?? [];
const maxTok = Math.max(1, ...stamped.map((c) => sumTok(c.tokens)));
const commitRows = stamped.map((c) => {
  const tok = sumTok(c.tokens);
  const bar = "🟧".repeat(Math.max(1, Math.round((tok / maxTok) * 5)));
  const subject = c.subject.length > 60 ? `${c.subject.slice(0, 57)}...` : c.subject;
  return `| \`${c.commit.slice(0, 7)}\` | ${subject} | ${c.author} | ${bar} | ${fmtTokens(tok)} | **${fmtCost(c.costUsd)}** |`;
});
const detailsBlock =
  commitRows.length > 0
    ? [
        "<details>",
        `<summary>💸 per-commit breakdown (${commitRows.length})</summary>`,
        "",
        "| commit | subject | author | burn | tokens | cost |",
        "|---|---|---|---|---:|---:|",
        ...commitRows,
        "",
        "</details>",
        "",
      ]
    : [];

const flavor = t.stampedCommits > 0 ? costFlavor(t.costUsd) : null;

const body = [
  MARKER,
  `### 🕯️ Wick — this PR cost **${cost}**`,
  "",
  `🔥 **${fmtTokens(sumTok(t.tokens))} tokens** · **${t.sessions} session${t.sessions === 1 ? "" : "s"}** · **${t.stampedCommits}/${t.commits}** commits stamped`,
  "",
  "| 📥 input | ⚡ cache read | 📝 cache write | 📤 output |",
  "|---:|---:|---:|---:|",
  `| ${fmtTokens(t.tokens.input)} | ${fmtTokens(t.tokens.cacheRead)} | ${fmtTokens(t.tokens.cacheWrite)} | ${fmtTokens(t.tokens.output)} |`,
  "",
  ...authorLines,
  ...detailsBlock,
  ...(flavor ? [`> ≈ ${flavor}`] : []),
  ...(report.unknownModels?.length
    ? ["", `⚠️ _no pricing for: ${report.unknownModels.join(", ")} — cost is a lower bound_`]
    : []),
].join("\n");

// Dry run: print the rendered comment and exit (local preview / tests).
if (process.env.WICK_DRY_RUN) {
  console.log(body);
  process.exit(0);
}

const token = process.env.GITHUB_TOKEN;
const repo = process.env.REPO;
const prNumber = process.env.PR_NUMBER;
if (!token || !repo || !prNumber) {
  console.error("missing GITHUB_TOKEN / REPO / PR_NUMBER");
  process.exit(1);
}

const api = `https://api.github.com/repos/${repo}`;
const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "user-agent": "wick-action",
};

async function main() {
  const listRes = await fetch(
    `${api}/issues/${prNumber}/comments?per_page=100`,
    { headers },
  );
  if (!listRes.ok) throw new Error(`list comments: ${listRes.status}`);
  const comments = await listRes.json();
  const existing = comments.find((c) => c.body && c.body.includes(MARKER));

  const res = existing
    ? await fetch(`${api}/issues/comments/${existing.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body }),
      })
    : await fetch(`${api}/issues/${prNumber}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
      });
  if (!res.ok) throw new Error(`upsert comment: ${res.status}`);
  console.log(existing ? "updated existing wick comment" : "created wick comment");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
