#!/usr/bin/env node
import { Command } from "commander";
import { registerProvider, getProviders } from "./providers/types.js";
import { createClaudeCodeProvider } from "./providers/claude-code/index.js";
import { install, uninstall, hasWickBlock, HOOK_EVENTS } from "./install.js";
import { postCommit, postMerge, postRewrite } from "./hooks/index.js";
import { buildReport, renderReport } from "./report.js";
import { repoRoot, tryGit } from "./git.js";
import { loadState } from "./state.js";
import { NOTES_REF } from "./notes.js";

registerProvider(createClaudeCodeProvider());

const program = new Command();
program
  .name("wick")
  .description("Measure AI token costs per git commit and PR")
  .version("0.1.0");

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
  .action((range: string | undefined, opts: { json?: boolean }) => {
    const report = buildReport(process.cwd(), range);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderReport(report));
    }
  });

program
  .command("hook")
  .description("internal entry point called by the installed git hooks")
  .argument("<event>", "post-commit | post-rewrite | post-merge")
  .option("--commit <sha>", "commit to stamp (post-commit)")
  .option("--pairs <pairs>", "old/new sha pairs (post-rewrite)")
  .action(async (event: string, opts: { commit?: string; pairs?: string }) => {
    // Hooks must never fail the git operation.
    try {
      const cwd = process.cwd();
      if (event === "post-commit") {
        await postCommit(cwd, opts.commit);
      } else if (event === "post-rewrite") {
        await postRewrite(cwd, opts.pairs ?? "");
      } else if (event === "post-merge") {
        await postMerge(cwd);
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
