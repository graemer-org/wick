#!/usr/bin/env node
/**
 * Post the no-commit CI cost comment from a `wick cost --json` file.
 * Appends a fresh comment — each no-commit run (an @claude answer, a triage) is
 * a distinct event, not a sticky report to upsert.
 *
 * The body is rendered by `renderNoCommitComment` in the built `dist/report.js`
 * so the token/cost formatting lives in one place; the untrusted model names in
 * the summary only ever flow JSON → `renderNoCommitComment` → the REST request
 * body, never a shell argument, so there is nothing to escape here.
 *
 * Env: GITHUB_TOKEN, REPO ("owner/name"), COMMENT_ISSUE (issue/PR number).
 * Set WICK_DRY_RUN=1 to print the rendered comment instead of posting.
 */
import { readFileSync } from "node:fs";
import { renderNoCommitComment } from "../dist/report.js";

const [, , summaryPath] = process.argv;
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const body = renderNoCommitComment(summary);

// Dry run: print the rendered comment and exit (local preview / tests).
if (process.env.WICK_DRY_RUN) {
  console.log(body);
  process.exit(0);
}

const token = process.env.GITHUB_TOKEN;
const repo = process.env.REPO;
const issue = process.env.COMMENT_ISSUE;
if (!token || !repo || !issue) {
  console.error("missing GITHUB_TOKEN / REPO / COMMENT_ISSUE");
  process.exit(1);
}

const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}/comments`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "wick-action",
  },
  body: JSON.stringify({ body }),
});
if (!res.ok) {
  console.error(`post comment: ${res.status}`);
  process.exit(1);
}
console.log("posted wick cost comment");
