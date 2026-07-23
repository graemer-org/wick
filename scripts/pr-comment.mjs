#!/usr/bin/env node
/**
 * Upsert the unified sticky Wick PR comment from a `wick report --json` file.
 * The comment holds BOTH halves of a PR's AI cost — the commit-attributed report
 * (this writer's half) and the no-commit action runs (the stamp writer's half).
 * This writer regenerates its own half fresh and replays the no-commit half
 * untouched from the comment's hidden state, so the two writers never clobber
 * each other. Found and edited in place by the single `PR_COMMENT_MARKER`.
 *
 * The body is rendered by `renderPrComment` in the built `dist/report.js` so the
 * token/cost/flavor formatting lives in one place; the untrusted model names in
 * the report/state only ever flow JSON → the renderer → the REST request body,
 * never a shell argument, so there is nothing to escape here.
 *
 * On the transition PR the comment may not carry the new marker yet — this
 * writer then adopts a legacy `<!-- wick-report -->` comment (or a `<!-- wick-cost
 * -->` one), importing any accumulated no-commit state, and deletes the stale
 * legacy comment(s) so the PR converges to a single comment.
 *
 * Env: GITHUB_TOKEN, REPO ("owner/name"), PR_NUMBER.
 * Set WICK_DRY_RUN=1 to print the rendered comment instead of posting.
 */
import { readFileSync } from "node:fs";
import {
  PR_COMMENT_MARKER,
  NO_COMMIT_MARKER,
  parseNoCommitComment,
  parsePrComment,
  renderPrComment,
} from "../dist/report.js";

const LEGACY_REPORT_MARKER = "<!-- wick-report -->";

const [, , reportPath] = process.argv;
const report = JSON.parse(readFileSync(reportPath, "utf8"));

// Dry run: render this report on its own (no existing comment to merge into).
if (process.env.WICK_DRY_RUN) {
  console.log(renderPrComment({ report }));
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
  const listRes = await fetch(`${api}/issues/${prNumber}/comments?per_page=100`, { headers });
  if (!listRes.ok) throw new Error(`list comments: ${listRes.status}`);
  const comments = await listRes.json();

  const unified = comments.find((c) => c.body && c.body.includes(PR_COMMENT_MARKER));
  const legacyReport = comments.find((c) => c.body && c.body.includes(LEGACY_REPORT_MARKER));
  const legacyCost = comments.find((c) => c.body && c.body.includes(NO_COMMIT_MARKER));

  // Preserve the stamp writer's no-commit half: from the unified comment if it
  // exists, else migrated one last time from a legacy no-commit comment.
  const state = unified ? (parsePrComment(unified.body) ?? {}) : {};
  if (!unified && legacyCost) {
    const migrated = parseNoCommitComment(legacyCost.body);
    if (migrated) state.noCommit = migrated;
  }
  state.report = report; // our half, always fresh
  const body = renderPrComment(state);

  // Reuse an existing comment id rather than stacking a new one; prefer the
  // unified comment, then the legacy report comment (its natural home).
  const target = unified ?? legacyReport ?? legacyCost;
  const res = target
    ? await fetch(`${api}/issues/comments/${target.id}`, {
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
  const written = res.ok ? await res.json() : null;
  console.log(target ? "updated wick PR comment" : "created wick PR comment");

  // Garbage-collect any leftover legacy comments now folded into the unified one
  // (best effort — a concurrent writer may have deleted them already). The delete
  // is unconditional even if a legacy state block was unparseable: that data was
  // already unrecoverable, and leaving the stale comment would defeat convergence.
  const writtenId = written?.id ?? target?.id;
  for (const c of comments) {
    if (c.id === writtenId) continue;
    if (c.body && (c.body.includes(LEGACY_REPORT_MARKER) || c.body.includes(NO_COMMIT_MARKER))) {
      await fetch(`${api}/issues/comments/${c.id}`, { method: "DELETE", headers }).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
