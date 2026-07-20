# CLAUDE.md

Wick is a TypeScript CLI (ESM, Node ≥ 22.12, `commander` as the only runtime dep) that stamps Claude Code token deltas onto git commits as notes under `refs/notes/wick` and aggregates them into per-PR cost reports, a sticky PR comment (GitHub Action), and a cost badge.

## Commands

```bash
npm run build            # tsc → dist/
npm test                 # vitest run (unit + integration; integration tests create throwaway git repos)
# Tests build fixtures through `TestFactory` in src/test-factory.ts (test-only:
# excluded from tsc in tsconfig, never ships in the npm package). Follow AAA
# (Arrange/Act/Assert) and use descriptive variable names in new tests.
npm run test:watch
node dist/cli.js <cmd>   # run the CLI (build first); `wick --version` reads package.json at runtime
```

## Architecture

Data flow: provider transcripts → attribution delta → git note per commit → report / action / badge.

- `src/providers/` — `UsageProvider` adapters. `claude-code/` discovers JSONL transcripts under `~/.claude/projects/<url-encoded-project-path>/`, dedupes streamed message snapshots by `message.id` (keep the **last** occurrence). Subagent usage lives in `<project-dir>/<session-id>/subagents/*.jsonl` and belongs to the parent session. `copilot-cli/` reads `~/.copilot/session-state/<uuid>/events.jsonl` (repo match via `session.start` `context.gitRoot`; full usage in `session.shutdown` `modelMetrics`) and, for live sessions, the central `~/.copilot/session-store.db` via the `sqlite3` CLI. **Copilot's `inputTokens` INCLUDES `cacheReadTokens`** (both surfaces, verified against the per-request price ledger) — wick subtracts; forgetting inflates cost ~10x.
- `src/attribution.ts` — session→commit token-delta logic (the hard part; see invariants).
- `src/notes.ts` — read/write/merge git notes under `refs/notes/wick`. `syncNotesToRemote` (pre-push) and `syncNotesFromRemote` (auto-fetch on `wick report`) both merge via the shared `mergeRefIntoLocalNotes` (per-commit `mergeNoteVersions`, never clobbering). `report` auto-fetches by default; `--no-fetch` and CI's action step skip it.
- `src/state.ts` — local bookkeeping in `.git/wick/` (`state.json` cumulative baselines + mkdir-based lock). Never committed.
- `src/install.ts` — chain-safe hook writer: appends a `# >>> wick >>> … # <<< wick <<<` block, never overwrites existing hooks. Hooks: `post-commit`, `post-rewrite`, `post-merge`, `pre-push` (pushes the notes ref).
- `src/report.ts` — range resolution (merge-base…HEAD by default), aggregation, by-author breakdown (mailmap-aware via `%aN/%aE`), ANSI rendering, shields.io badge JSON, budget evaluation.
- `src/config.ts` — repo config from `.wick/config.json` (currently: per-PR budget with warn fraction). Tolerant loader, never throws. Budgets attach only to branch-scoped ranges (not full-history "HEAD"). Budgets inform, they never block — the maintainer rejected an enforce/fail mode because an over-budget PR can't get cheaper, so a failing check would dead-end the PR; over-budget surfaces as a CI warning annotation instead. Don't reintroduce enforcement.
- `src/reconcile.ts` — consolidate stamps onto commits the hooks never saw (squash merge, cherry-pick, reset).
- `action.yml` — composite action, `mode: report` (sticky PR comment via `scripts/pr-comment.mjs`) and `mode: reconcile` (remap stamps after squash/rebase merge).
- `.github/workflows/` — `wick.yml` (dogfooding PR comment + reconcile), `badge.yml` (publishes badge JSON to the orphan `wick-badge` branch), `release.yml` (release-please).

## Invariants — violations here were real bugs

- **Provider isolation:** nothing outside `src/providers/` may import provider-specific code; everything else consumes only `SessionUsage`/`SessionRef` from `src/providers/types.ts`. A test enforces this with a mock second provider.
- **Delta attribution compares cumulative session totals against stored cumulative baselines.** Do not pass a time window to the provider to compute deltas — it silently zeroes every delta after the first commit.
- **Baselines are monotonic.** Transcript reads can race Claude Code rewriting the file and report shrunken totals; never lower a stored baseline, or the next stamp double-counts.
- **Hooks directory is `git rev-parse --git-path hooks`** (worktrees keep hooks in the common git dir), not `--absolute-git-dir`/hooks. Respect `core.hooksPath`.
- **Hooks never fail the git operation.** Any error → warn and exit 0. Providers that find nothing return an empty list, never throw into the hook path.
- **Never force-fetch `refs/notes/wick` in a working clone** (`git fetch origin '+refs/notes/wick:refs/notes/wick'`) — it clobbers local stamps that haven't been pushed yet, and the delta baselines in `.git/wick/state.json` already advanced, so the tokens are unrecoverable except via the dangling old notes commit. Forced fetch is CI-only (fresh checkout, no local stamps).
- **The notes ref diverges routinely** — CI's reconcile job pushes notes commits while local stamping advances the same ref, so a plain `git push origin refs/notes/wick` gets rejected non-fast-forward. The `pre-push` hook handles this via `syncNotesToRemote()` (fetch → per-commit merge → `--force-with-lease` pinned to the fetched sha). A silent `|| true` push here once lost a PR's cost.
- **post-rewrite pairs must be processed grouped by new commit** (fixup/squash rebases map many old commits to one new one), with the target note read once up front. git's own `notes.rewriteRef` copying runs *before* the hook and its result depends on `notes.rewriteMode` (default `concatenate` → malformed JSON `readNote` treats as absent; `overwrite` → one source copied verbatim) — pair-at-a-time merging against a mutating target double-counted the fixup stamp under `overwrite`. See `remapNotes` in notes.ts; real-rebase regression tests cover both modes.
- **Two note-merge semantics, don't mix them up:** `mergeNotes` SUMS per (provider, id, model) — correct when combining fresh deltas into one stamp (`upsertNote`). `mergeNoteVersions` takes the per-class MAX — correct when reconciling diverged local/remote copies of the *same* note, where summing would double-count a stale copy.
- Unknown model → show tokens, cost `n/a` (null in JSON), never guess a price.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `ci:`, `docs:` …). release-please cuts releases from them — never hand-bump the version in `package.json` or edit `CHANGELOG.md`.
- npm package name is `@wickhq/wick` (bare `wick` was taken); the bin/command stays `wick`. Publishing uses npm **trusted publishing** (OIDC, no token secret) from `release.yml`; the job skips until the package exists on npm (first publish is manual). Requires npm ≥ 11.5.1 on the runner.
- The npm package ships only runtime files (`dist`, `pricing.json`, `scripts/prepare.mjs` + npm-forced README/LICENSE). `action.yml` and `scripts/pr-comment.mjs` are GitHub-Action-only and stay out; repo docs (CLAUDE.md etc.) must never enter the `files` whitelist. Check with `npm pack --dry-run`.
- **Releases and PR merges are the maintainer's job — never do either autonomously.** Do not merge any PR, do not merge release-please PRs (`chore(main): release …`), create tags, publish GitHub releases, or trigger the Release workflow. Open PRs, get CI green, and stop there.
- License is Business Source License 1.1 (source-available, not open source) — a future B2B SaaS may be built on Wick. Don't relicense, don't add dependencies with copyleft licenses, and keep the `LICENSE` parameters block intact.
- This repo dogfoods Wick: `npm install` auto-installs the hooks via `scripts/prepare.mjs` (skipped in CI / as a dependency; opt-out `WICK_AUTOINSTALL=0`), so local commits get stamped. Don't be surprised by `refs/notes/wick` activity or `.git/wick/` state.
- Pricing lives in bundled `pricing.json` (USD per 1M tokens, keyed by provider + model prefix), overridable per-repo via `.wick/pricing.json`.
