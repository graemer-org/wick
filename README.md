# 🕯️ Wick

[![wick cost](https://github.com/graemer-org/wick/raw/wick-badge/wick-badge.svg)](https://github.com/graemer-org/wick/blob/main/README.md#cost-badge)

**Know what your code costs.** Wick measures AI token spend per commit and rolls it up per Pull Request — so every PR answers the question nobody can answer today: *what did this actually cost to build?*

```
🕯️ Wick — this PR cost $4.12
1.2M tokens across 7 sessions · 14/15 commits stamped
input 38k · cache read 5.1M · cache write 210k · output 96k

by author: Alice $3.20 · Bob $0.92
```

Like a wick, your tokens burn down. Wick shows you where.

## Why

AI agents write more and more of our code. Every session burns tokens, but the costs vanish into a monthly bill with zero attribution. Wick attaches spend to the thing you actually ship: the commit, the branch, the PR. Developers see the price of their workflow in real time; teams see where the money goes.

Wick currently supports **Claude Code**. The core is provider-agnostic — more providers are on the roadmap.

## How it works

No server, no telemetry, no account. Everything lives in git and on your machine.

1. **Read** — Claude Code writes a local JSONL transcript for every session, including token usage per message. Wick parses these; your prompts and code never leave your disk.
2. **Stamp** — git hooks (installed by Wick itself, no Husky required) attach the session's token delta to each commit as a [git note](https://git-scm.com/docs/git-notes) under `refs/notes/wick`. Rebases and amends are handled — stamps follow rewritten commits.
3. **Report** — `wick report` sums the notes for any commit range, with a per-commit table and a breakdown by commit author. The GitHub Action does the same for a PR and posts a sticky cost comment.

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

Notes travel with your pushes automatically — `wick install` wires a `pre-push` hook that ships `refs/notes/wick` alongside your branches (manual: `git push origin refs/notes/wick`).

Add the action to your workflow — two jobs: one posts the comment while the PR is open, one remaps stamps after a squash or rebase merge:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read
  pull-requests: write

jobs:
  wick-report:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: graemer-org/wick@v1

  wick-reconcile:
    if: github.event.action == 'closed' && github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions:
      contents: write # push refs/notes/wick
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.ref }}
          fetch-depth: 0
      - uses: graemer-org/wick@v1
        with: { mode: reconcile }
```

Every PR gets one comment with the total cost (and a per-author split when several people pushed), updated in place on every push — no comment spam. The `reconcile` job detects how the PR was merged: merge commit → nothing to do, squash → all stamps consolidated onto the squash commit, rebase → stamps remapped 1:1. Merge however you like; the costs follow.

## Cost badge

The badge at the top of this README is the live, all-time cost of building Wick. `wick badge` renders it for any commit range:

```bash
wick badge            # shields.io endpoint JSON for the whole default branch
# {"schemaVersion":1,"label":"🕯️ wick","message":"$23.41 burned","color":"brightgreen"}
wick badge --svg      # self-hosted SVG — no shields.io, works on private repos
```

This repo's [badge workflow](.github/workflows/badge.yml) regenerates both on every push to `main` (and after merge reconciliation) and force-pushes them to an orphan `wick-badge` branch. Embed whichever fits your repo:

```markdown
<!-- private or public — GitHub serves same-repo images authenticated -->
![wick cost](https://github.com/<owner>/<repo>/raw/wick-badge/wick-badge.svg)

<!-- public repos can go through shields.io instead -->
![wick cost](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2F<owner>%2F<repo>%2Fwick-badge%2Fwick-badge.json)
```

The color heats up as the money burns: green under $10, red past $2,000.

## Commands

```
wick install        install hooks in the current repo (idempotent)
wick uninstall      remove Wick's hook blocks
wick status         health check: hooks, providers, last stamp
wick report [range] per-commit table + by-author breakdown + total cost
                    (default range: merge-base…HEAD)
wick report --json  machine-readable output
wick badge [range]  shields.io endpoint JSON for a cost badge
wick reconcile --onto <sha> <range>
                    copy stamps onto a commit the hooks never saw
                    (manual squash merge, cherry-pick, reset)
```

## Pricing

Costs are computed from a bundled pricing table (USD per 1M tokens, split by input / cache read / cache write / output, per model). Override it by dropping a `.wick/pricing.json` into your repo — useful for negotiated rates or new models. Unknown models show raw tokens and `n/a` instead of a guessed number.

## Accuracy notes

Wick reads what Claude Code writes to disk and dedupes streamed message snapshots by message ID, so totals match what the API actually billed — not inflated log sums. A few honest limitations in the current version:

- Sessions from another machine aren't captured (stamps carry stable session IDs, so reconciliation is possible later).
- `commit --amend` and `rebase` are fully handled by hooks. **Squash and rebase merges on GitHub** are reconciled automatically by the Action (`mode: reconcile`, triggered when a PR is merged) — the stamps are remapped onto the new commits on the base branch. For manual cases (`git merge --squash`, `cherry-pick`, `reset`), `wick reconcile --onto <new-sha> <old-range>` copies the stamps over, idempotently.
- Wick never blocks or fails a git operation. If anything goes wrong, your commit goes through and Wick logs a warning.
- The by-author breakdown groups by git author and respects [`.mailmap`](https://git-scm.com/docs/gitmailmap) — useful because GitHub squash commits carry your account's primary email while local commits may use the noreply address. One line in `.mailmap` merges them.

## Dogfooding

This repo runs Wick on itself. Every PR here carries its own cost comment, the badge up top shows the running total, and `wick report` on `main` tells you exactly what building Wick has cost so far. If that number ever stops being interesting, we've failed.

## Contributing

```bash
git clone https://github.com/graemer-org/wick.git && cd wick
npm install            # also builds and installs the wick hooks (dogfooding)
npm test               # vitest
```

`npm install` auto-installs the git hooks via the `prepare` script — Husky-style, so your commits to Wick get stamped like everyone else's without a manual step. It's skipped in CI and when Wick is a dependency, opt-out with `WICK_AUTOINSTALL=0`, and it never fails your install; `npx wick install` is the manual fallback. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/); releases are cut automatically by release-please.

## Roadmap

- GitHub Copilot provider (the adapter interface already exists)
- Org-level aggregation across repos and teams
- Cost budgets and thresholds per PR

## License

MIT