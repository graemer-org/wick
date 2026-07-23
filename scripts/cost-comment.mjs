#!/usr/bin/env node
/**
 * Upsert the accumulating no-commit CI cost comment from a `wick cost --json`
 * file. A PR sees many no-commit runs (every `@claude` answer, every review /
 * triage turn); rather than stack one comment per run, they fold into ONE
 * comment found by its hidden marker — the same sticky pattern `pr-comment.mjs`
 * uses. The previous total is carried in the comment's hidden base64 state
 * block and re-accumulated here.
 *
 * The body is rendered by `renderNoCommitComment` in the built `dist/report.js`
 * so the token/cost formatting lives in one place; the untrusted model names in
 * the summary only ever flow JSON → the renderer → the REST request body, never
 * a shell argument, so there is nothing to escape here.
 *
 * Env: GITHUB_TOKEN, REPO ("owner/name"), COMMENT_ISSUE (issue/PR number).
 * Optional WICK_RUN_LABEL / WICK_RUN_URL label + link this run's breakdown row.
 * Set WICK_DRY_RUN=1 to print the rendered comment instead of posting.
 */
import { readFileSync } from "node:fs";
import {
  NO_COMMIT_MARKER,
  accumulateNoCommit,
  parseNoCommitComment,
  renderNoCommitComment,
} from "../dist/report.js";

const [, , summaryPath] = process.argv;
const runSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
const runMeta = { label: process.env.WICK_RUN_LABEL, url: process.env.WICK_RUN_URL };

// Dry run: render this run on its own (no existing comment to accumulate into).
if (process.env.WICK_DRY_RUN) {
  console.log(renderNoCommitComment(accumulateNoCommit(null, runSummary, runMeta)));
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
  const existing = comments.find((c) => c.body && c.body.includes(NO_COMMIT_MARKER));

  // Fold this run into the total the existing comment carries (fresh if none).
  const state = accumulateNoCommit(existing ? parseNoCommitComment(existing.body) : null, runSummary, runMeta);
  const body = renderNoCommitComment(state);

  const res = existing
    ? await fetch(`${api}/issues/comments/${existing.id}`, {
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
  console.log(existing ? "updated wick cost comment" : "created wick cost comment");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
