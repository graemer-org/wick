#!/usr/bin/env node
/**
 * Fold a no-commit CI run's cost (from a `wick cost --json` file) into the
 * unified sticky Wick PR comment. That comment holds BOTH halves of a PR's AI
 * cost — the commit-attributed report (the report writer's half) and the
 * accumulated no-commit action runs (this writer's half). A PR sees many
 * no-commit runs (every `@claude` answer, every review/triage turn); rather than
 * stack a comment per run they accumulate into the one comment found by
 * `PR_COMMENT_MARKER`. This writer folds its run into the no-commit half and
 * replays the report half untouched from the comment's hidden state, so the two
 * writers never clobber each other.
 *
 * The body is rendered by `renderPrComment` in the built `dist/report.js` so the
 * token/cost formatting lives in one place; the untrusted model names in the
 * summary only ever flow JSON → the renderer → the REST request body, never a
 * shell argument, so there is nothing to escape here.
 *
 * On the transition PR (or an issue) the comment may not carry the new marker
 * yet — this writer then adopts a legacy `<!-- wick-cost -->` comment, importing
 * its accumulated runs, and deletes it. It never adopts or deletes a legacy
 * `<!-- wick-report -->` comment: it has no report data to preserve, so it leaves
 * that comment for the report writer to migrate.
 *
 * Env: GITHUB_TOKEN, REPO ("owner/name"), COMMENT_ISSUE (issue/PR number).
 * Optional WICK_RUN_LABEL / WICK_RUN_URL label + link this run's breakdown row.
 * Set WICK_DRY_RUN=1 to print the rendered comment instead of posting.
 */
import { readFileSync } from "node:fs";
import {
  PR_COMMENT_MARKER,
  NO_COMMIT_MARKER,
  accumulateNoCommit,
  parseNoCommitComment,
  parsePrComment,
  renderPrComment,
} from "../dist/report.js";

const [, , summaryPath] = process.argv;
const runSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
const runMeta = { label: process.env.WICK_RUN_LABEL, url: process.env.WICK_RUN_URL };

// Dry run: render this run on its own (no existing comment to accumulate into).
if (process.env.WICK_DRY_RUN) {
  console.log(renderPrComment({ noCommit: accumulateNoCommit(null, runSummary, runMeta) }));
  process.exit(0);
}

const token = process.env.GITHUB_TOKEN;
const repo = process.env.REPO;
const issue = process.env.COMMENT_ISSUE;
if (!token || !repo || !issue) {
  console.error("missing GITHUB_TOKEN / REPO / COMMENT_ISSUE");
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
  const listRes = await fetch(`${api}/issues/${issue}/comments?per_page=100`, { headers });
  if (!listRes.ok) throw new Error(`list comments: ${listRes.status}`);
  const comments = await listRes.json();

  const unified = comments.find((c) => c.body && c.body.includes(PR_COMMENT_MARKER));
  const legacyCost = comments.find((c) => c.body && c.body.includes(NO_COMMIT_MARKER));

  // Preserve the report writer's half and reload the no-commit total: from the
  // unified comment if it exists, else migrated once from a legacy comment.
  const state = unified ? (parsePrComment(unified.body) ?? {}) : {};
  if (!unified && legacyCost) state.noCommit = parseNoCommitComment(legacyCost.body) ?? undefined;
  state.noCommit = accumulateNoCommit(state.noCommit ?? null, runSummary, runMeta);
  const body = renderPrComment(state);

  const target = unified ?? legacyCost;
  const res = target
    ? await fetch(`${api}/issues/comments/${target.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body }),
      })
    : await fetch(`${api}/issues/${issue}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
      });
  if (!res.ok) throw new Error(`upsert comment: ${res.status}`);
  const written = res.ok ? await res.json() : null;
  console.log(target ? "updated wick PR comment" : "created wick PR comment");

  // Garbage-collect any leftover legacy no-commit comments now folded in (best
  // effort). Leave legacy report comments alone — the report writer owns those.
  // The delete is unconditional even if the legacy state was unparseable: that
  // data was already unrecoverable, and a stale comment would defeat convergence.
  const writtenId = written?.id ?? target?.id;
  for (const c of comments) {
    if (c.id === writtenId) continue;
    if (c.body && c.body.includes(NO_COMMIT_MARKER)) {
      await fetch(`${api}/issues/comments/${c.id}`, { method: "DELETE", headers }).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
