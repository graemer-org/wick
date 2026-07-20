# CLAUDE.md

Wick is a TypeScript CLI (ESM, Node ≥ 20, `commander` as the only runtime dep) that stamps Claude Code token deltas onto git commits as notes under `refs/notes/wick` and aggregates them into per-PR cost reports, a sticky PR comment (GitHub Action), and a cost badge.

## Commands

```bash
npm run build            # tsc → dist/
npm test                 # vitest run (unit + integration; integration tests create throwaway git repos)
npm run test:watch
node dist/cli.js <cmd>   # run the CLI (build first); `wick --version` reads package.json at runtime
```

## Architecture

Data flow: provider transcripts → attribution delta → git note per commit → report / action / badge.

- `src/providers/` — `UsageProvider` adapters. `claude-code/` discovers JSONL transcripts under `~/.claude/projects/<url-encoded-project-path>/`, dedupes streamed message snapshots by `message.id` (keep the **last** occurrence). Subagent usage lives in `<project-dir>/<session-id>/subagents/*.jsonl` and belongs to the parent session.
- `src/attribution.ts` — session→commit token-delta logic (the hard part; see invariants).
- `src/notes.ts` — read/write/merge git notes under `refs/notes/wick`.
- `src/state.ts` — local bookkeeping in `.git/wick/` (`state.json` cumulative baselines + mkdir-based lock). Never committed.
- `src/install.ts` — chain-safe hook writer: appends a `# >>> wick >>> … # <<< wick <<<` block, never overwrites existing hooks. Hooks: `post-commit`, `post-rewrite`, `post-merge`, `pre-push` (pushes the notes ref).
- `src/report.ts` — range resolution (merge-base…HEAD by default), aggregation, by-author breakdown (mailmap-aware via `%aN/%aE`), ANSI rendering, shields.io badge JSON.
- `src/reconcile.ts` — consolidate stamps onto commits the hooks never saw (squash merge, cherry-pick, reset).
- `action.yml` — composite action, `mode: report` (sticky PR comment via `scripts/pr-comment.mjs`) and `mode: reconcile` (remap stamps after squash/rebase merge).
- `.github/workflows/` — `wick.yml` (dogfooding PR comment + reconcile), `badge.yml` (publishes badge JSON to the orphan `wick-badge` branch), `release.yml` (release-please).

## Invariants — violations here were real bugs

- **Provider isolation:** nothing outside `src/providers/` may import provider-specific code; everything else consumes only `SessionUsage`/`SessionRef` from `src/providers/types.ts`. A test enforces this with a mock second provider.
- **Delta attribution compares cumulative session totals against stored cumulative baselines.** Do not pass a time window to the provider to compute deltas — it silently zeroes every delta after the first commit.
- **Baselines are monotonic.** Transcript reads can race Claude Code rewriting the file and report shrunken totals; never lower a stored baseline, or the next stamp double-counts.
- **Hooks directory is `git rev-parse --git-path hooks`** (worktrees keep hooks in the common git dir), not `--absolute-git-dir`/hooks. Respect `core.hooksPath`.
- **Hooks never fail the git operation.** Any error → warn and exit 0. Providers that find nothing return an empty list, never throw into the hook path.
- Unknown model → show tokens, cost `n/a` (null in JSON), never guess a price.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `ci:`, `docs:` …). release-please cuts releases from them — never hand-bump the version in `package.json` or edit `CHANGELOG.md`.
- This repo dogfoods Wick: contributors run `npx wick install` after cloning, so local commits get stamped. Don't be surprised by `refs/notes/wick` activity or `.git/wick/` state.
- Pricing lives in bundled `pricing.json` (USD per 1M tokens, keyed by provider + model prefix), overridable per-repo via `.wick/pricing.json`.
