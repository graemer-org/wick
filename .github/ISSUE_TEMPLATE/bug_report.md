---
name: Bug report
about: Something in wick behaves incorrectly (wrong cost, missing stamp, hook/notes/action misbehaving).
title: "bug: "
labels: bug
---

<!--
A triage bot reads every new issue, checks it against the code, and posts a plan.
The more concrete you are, the more useful that reply is. Please search existing
issues first, and delete the "(optional)" sections you don't need.
-->

## What happened?
<!-- The actual behavior. e.g. `wick report` showed $0.00 for a PR even though a Claude Code session ran. -->

## What you expected
<!-- What should have happened instead. -->

## Steps to reproduce
<!-- Exact commands / sequence. Include the git operations (commit, rebase, squash-merge…) if relevant — attribution bugs usually hinge on them. -->

1.
2.
3.

## Environment

- **Surface:** <!-- report / cost / badge / hook / install / reconcile / notes sync / GitHub Action / pricing / not sure -->
- **Provider:** <!-- claude-code / copilot-cli / n/a / not sure -->
- **wick version:** <!-- `wick --version`, or the action ref / npm version -->
- **Node & OS:** <!-- `node --version` (wick needs ≥ 22.12) + OS -->

## Relevant output (optional)
<!-- Paste failing output; redact anything sensitive. -->

```
```

## Suspected area (optional)
<!-- A hunch about the file or invariant involved? The triage bot cites `path:line`, so a lead helps. -->
