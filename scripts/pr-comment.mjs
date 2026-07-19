#!/usr/bin/env node
/**
 * Upsert the sticky Wick PR comment from a `wick report --json` file.
 * Finds an existing comment by the hidden marker and edits it in place
 * instead of stacking new comments.
 *
 * Env: GITHUB_TOKEN, REPO ("owner/name"), PR_NUMBER.
 */
import { readFileSync } from "node:fs";

const MARKER = "<!-- wick-report -->";

const [, , reportPath] = process.argv;
const report = JSON.parse(readFileSync(reportPath, "utf8"));

const token = process.env.GITHUB_TOKEN;
const repo = process.env.REPO;
const prNumber = process.env.PR_NUMBER;
if (!token || !repo || !prNumber) {
  console.error("missing GITHUB_TOKEN / REPO / PR_NUMBER");
  process.exit(1);
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const t = report.totals;
const total =
  t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.output;
const cost = t.costUsd === null ? "n/a" : `$${t.costUsd.toFixed(2)}`;
function fmtCost(c) {
  return c === null ? "n/a" : `$${c.toFixed(2)}`;
}

const authorLines =
  (report.authors?.length ?? 0) > 1
    ? [
        "",
        "by author: " +
          report.authors
            .map((a) => `${a.author} ${fmtCost(a.costUsd)}`)
            .join(" · "),
      ]
    : [];

const body = [
  MARKER,
  `🕯️ **Wick — this PR cost ${cost}**`,
  "",
  `${fmtTokens(total)} tokens across ${t.sessions} session${t.sessions === 1 ? "" : "s"} · ${t.stampedCommits}/${t.commits} commits stamped`,
  `input ${fmtTokens(t.tokens.input)} · cache read ${fmtTokens(t.tokens.cacheRead)} · cache write ${fmtTokens(t.tokens.cacheWrite)} · output ${fmtTokens(t.tokens.output)}`,
  ...authorLines,
  ...(report.unknownModels?.length
    ? ["", `_no pricing for: ${report.unknownModels.join(", ")} — cost is a lower bound_`]
    : []),
].join("\n");

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
