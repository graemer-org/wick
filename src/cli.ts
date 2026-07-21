#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { registerProvider, getProviders, collectUsage } from "./providers/types.js";
import { createClaudeCodeProvider } from "./providers/claude-code/index.js";
import { createCopilotCliProvider } from "./providers/copilot-cli/index.js";
import { install, uninstall, hasWickBlock, HOOK_EVENTS } from "./install.js";
import { postCommit, postMerge, postRewrite, prePush } from "./hooks/index.js";
import {
  buildBadge,
  buildReport,
  renderBadgeSvg,
  renderCostLine,
  renderReport,
  summarizeCost,
} from "./report.js";
import { loadPricing } from "./pricing.js";
import { notesRemote, repoRoot, tryGit } from "./git.js";
import { loadState } from "./state.js";
import { NOTES_REF, syncNotesFromRemote } from "./notes.js";

registerProvider(createClaudeCodeProvider());
registerProvider(createCopilotCliProvider());

// dist/cli.js -> ../package.json (package root); keeps --version in sync
// with release-please bumps.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const program = new Command();
program
  .name("wick")
  .description("Measure AI token costs per git commit and PR")
  .version(pkg.version);

program
  .command("install")
  .description("install git hooks in the current repo (idempotent)")
  .action(async () => {
    const result = await install(process.cwd());
    console.log(`wick: hooks installed in ${result.hooksDir}`);
    console.log(`wick: ${result.installed.join(", ")}`);
    console.log(
      `wick: notes are pushed automatically on git push (pre-push hook); ` +
        `manual: git push origin ${NOTES_REF}`,
    );
  });

program
  .command("uninstall")
  .description("remove wick hook blocks (leaves other hook content intact)")
  .action(async () => {
    await uninstall(process.cwd());
    console.log("wick: hook blocks removed");
  });

program
  .command("status")
  .description("show hook, session and stamp status for this repo")
  .action(async () => {
    const cwd = process.cwd();
    let root: string;
    try {
      root = repoRoot(cwd);
    } catch {
      console.log("wick: not inside a git repository");
      process.exitCode = 1;
      return;
    }
    console.log(`repo: ${root}`);
    for (const event of HOOK_EVENTS) {
      const ok = await hasWickBlock(root, event);
      console.log(`hook ${event}: ${ok ? "installed" : "not installed"}`);
    }
    const state = await loadState(root);
    console.log(`last stamp: ${state.lastStampTs ?? "never"}`);
    for (const provider of getProviders()) {
      try {
        const refs = await provider.discoverSessions(root, {});
        console.log(`provider ${provider.id}: ${refs.length} session(s) found`);
      } catch {
        console.log(`provider ${provider.id}: error while discovering sessions`);
      }
    }
    const noteCount = tryGit(
      ["notes", `--ref=${NOTES_REF}`, "list"],
      root,
    );
    const n = noteCount ? noteCount.split("\n").filter(Boolean).length : 0;
    console.log(`stamped commits (${NOTES_REF}): ${n}`);
  });

program
  .command("report")
  .description("token/cost report for a commit range (default: merge-base with default branch → HEAD)")
  .argument("[range]", "git revision range, e.g. main..HEAD")
  .option("--json", "machine-readable output")
  .option("--no-color", "disable ANSI colors")
  .option("--no-fetch", "skip auto-fetching refs/notes/wick from the remote")
  .action((range: string | undefined, opts: { json?: boolean; color?: boolean; fetch?: boolean }) => {
    const cwd = process.cwd();
    // Notes don't travel with a normal clone/fetch, so a fresh checkout would
    // show 0 stamps. Pull them first (non-destructive merge); best-effort and
    // never fatal. Status goes to stderr so --json stdout stays clean.
    if (opts.fetch !== false) {
      try {
        const root = repoRoot(cwd);
        const remote = notesRemote(root);
        if (remote && syncNotesFromRemote(remote, root) === "updated" && !opts.json) {
          console.error(`wick: fetched refs/notes/wick from ${remote}`);
        }
      } catch {
        // not a repo / git unavailable — let buildReport surface the real error
      }
    }
    const report = buildReport(cwd, range);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const color =
        opts.color !== false &&
        process.stdout.isTTY === true &&
        process.env.NO_COLOR === undefined;
      console.log(renderReport(report, { color }));
    }
  });

program
  .command("badge")
  .description(
    "shields.io endpoint JSON for the cost of a commit range (default: full history on the default branch)",
  )
  .argument("[range]", "git revision range, e.g. HEAD or main..HEAD")
  .option("--label <label>", "badge label", "🕯️ wick")
  .option("--svg", "emit a self-hosted SVG instead of endpoint JSON (works on private repos)")
  .action((range: string | undefined, opts: { label: string; svg?: boolean }) => {
    const report = buildReport(process.cwd(), range);
    const badge = buildBadge(report, opts.label);
    console.log(opts.svg ? renderBadgeSvg(badge) : JSON.stringify(badge));
  });

program
  .command("cost")
  .description(
    "total token cost of the AI sessions touching this repo right now (no commit needed) — used by CI to report the cost of a run that produced no commit",
  )
  .option("--json", "machine-readable output")
  .action(async (opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const root = repoRoot(cwd);
    // Read-only: collect current cumulative usage and price it. No delta, no
    // note write, no state mutation — this must not disturb the stamp baselines.
    const usage = await collectUsage(root, {});
    const summary = summarizeCost(usage, loadPricing(root));
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(renderCostLine(summary));
    if (summary.unknownModels.length > 0) {
      console.error(
        `wick: no pricing for ${summary.unknownModels.join(", ")} — cost shown is a lower bound`,
      );
    }
  });

program
  .command("reconcile")
  .description(
    "copy stamps from source commits onto a rewritten commit not covered by post-rewrite (squash merge, cherry-pick, reset)",
  )
  .requiredOption("--onto <sha>", "the new commit to stamp (e.g. the squash commit)")
  .argument("<range>", "source commits, e.g. main..pr-head")
  .action(async (range: string, opts: { onto: string }) => {
    const { consolidateNotes, rangeShas } = await import("./reconcile.js");
    const cwd = process.cwd();
    const shas = rangeShas(cwd, range);
    if (shas.length === 0) {
      console.log(`wick: no commits in range ${range}`);
      return;
    }
    const result = consolidateNotes(cwd, shas, opts.onto);
    switch (result) {
      case "written":
        console.log(`wick: consolidated ${shas.length} commit(s) onto ${opts.onto}`);
        break;
      case "target-already-stamped":
        console.log(`wick: ${opts.onto} already has a stamp — nothing to do`);
        break;
      case "no-source-notes":
        console.log(`wick: no stamps found in ${range} — nothing to do`);
        break;
    }
  });

program
  .command("hook")
  .description("internal entry point called by the installed git hooks")
  .argument("<event>", "post-commit | post-rewrite | post-merge | pre-push")
  .option("--commit <sha>", "commit to stamp (post-commit)")
  .option("--pairs <pairs>", "old/new sha pairs (post-rewrite)")
  .option("--remote <remote>", "remote being pushed to (pre-push)")
  .action(async (event: string, opts: { commit?: string; pairs?: string; remote?: string }) => {
    // Hooks must never fail the git operation.
    try {
      const cwd = process.cwd();
      if (event === "post-commit") {
        await postCommit(cwd, opts.commit);
      } else if (event === "post-rewrite") {
        await postRewrite(cwd, opts.pairs ?? "");
      } else if (event === "post-merge") {
        await postMerge(cwd);
      } else if (event === "pre-push") {
        await prePush(cwd, opts.remote ?? "");
      }
    } catch (err) {
      console.error(`wick: warning: ${err instanceof Error ? err.message : err}`);
    }
    process.exitCode = 0;
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`wick: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
