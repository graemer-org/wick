# 🕯️ Wick

**Know what your code costs.** Wick measures AI token spend per commit and rolls it up per Pull Request — so every PR answers the question nobody can answer today: *what did this actually cost to build?*

```
🕯️ Wick — this PR cost $4.12
1.2M tokens across 7 sessions · 14 commits
input 38k · cache read 5.1M · cache write 210k · output 96k
```

Like a wick, your tokens burn down. Wick shows you where.

## Why

AI agents write more and more of our code. Every session burns tokens, but the costs vanish into a monthly bill with zero attribution. Wick attaches spend to the thing you actually ship: the commit, the branch, the PR. Developers see the price of their workflow in real time; teams see where the money goes.

Wick currently supports **Claude Code**. The core is provider-agnostic — more providers are on the roadmap.

## How it works

No server, no telemetry, no account. Everything lives in git and on your machine.

1. **Read** — Claude Code writes a local JSONL transcript for every session, including token usage per message. Wick parses these; your prompts and code never leave your disk.
2. **Stamp** — git hooks (installed by Wick itself, no Husky required) attach the session's token delta to each commit as a [git note](https://git-scm.com/docs/git-notes) under `refs/notes/wick`. Rebases and amends are handled — stamps follow rewritten commits.
3. **Report** — `wick report` sums the notes for any commit range. The GitHub Action does the same for a PR and posts a sticky cost comment.

## Quick start

```bash
npm install -g wick        # or: npx wick …
cd your-repo
wick install               # installs chain-safe git hooks, done
```

Work as usual. Then:

```bash
wick report                # cost of your current branch vs. main
wick status                # hooks installed? sessions detected?
```

`wick install` never overwrites existing hooks — it appends a delimited block and plays nice with Husky or hand-written hooks. `wick uninstall` removes exactly that block and nothing else.

## PR comments via GitHub Action

Push your notes alongside your branches (Wick can wire this into `pre-push` during install):

```bash
git push origin refs/notes/wick
```

Then add the action to your workflow:

```yaml
- uses: your-org/wick@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

Every PR gets one comment with the total cost, updated in place on every push — no comment spam.

## Commands

```
wick install        install hooks in the current repo (idempotent)
wick uninstall      remove Wick's hook blocks
wick status         health check: hooks, providers, last stamp
wick report [range] per-commit table + total cost (default: merge-base…HEAD)
wick report --json  machine-readable output
```

## Pricing

Costs are computed from a bundled pricing table (USD per 1M tokens, split by input / cache read / cache write / output, per model). Override it by dropping a `.wick/pricing.json` into your repo — useful for negotiated rates or new models. Unknown models show raw tokens and `n/a` instead of a guessed number.

## Accuracy notes

Wick reads what Claude Code writes to disk and dedupes streamed message snapshots by message ID, so totals match what the API actually billed — not inflated log sums. A few honest limitations in the current version:

- Sessions from another machine aren't captured (stamps carry stable session IDs, so reconciliation is possible later).
- `cherry-pick` and `reset` can orphan stamps; `commit --amend` and `rebase` are fully handled.
- Wick never blocks or fails a git operation. If anything goes wrong, your commit goes through and Wick logs a warning.

## Dogfooding

This repo runs Wick on itself. Every PR here carries its own cost comment, and `wick report` on `main` tells you exactly what building Wick has cost so far. If that number ever stops being interesting, we've failed.

## Roadmap

- GitHub Copilot provider (the adapter interface already exists)
- Org-level aggregation across repos and teams
- Cost budgets and thresholds per PR

## License

MIT