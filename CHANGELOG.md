# Changelog

## [0.5.0](https://github.com/graemer-org/wick/compare/v0.4.1...v0.5.0) (2026-07-20)


### Features

* publish as @wickhq/wick ([#21](https://github.com/graemer-org/wick/issues/21)) ([f0841cd](https://github.com/graemer-org/wick/commit/f0841cd629d86264896c0f2fecac0e181d39c827))

## [0.4.1](https://github.com/graemer-org/wick/compare/v0.4.0...v0.4.1) (2026-07-20)


### Bug Fixes

* double-counted fixup stamps when notes.rewriteMode=overwrite ([#19](https://github.com/graemer-org/wick/issues/19)) ([7ef0cac](https://github.com/graemer-org/wick/commit/7ef0cac267bc1603f47bf73ceb8f97b90a1c7299))

## [0.4.0](https://github.com/graemer-org/wick/compare/v0.3.0...v0.4.0) (2026-07-20)


### Features

* per-PR cost budgets with warn and enforce thresholds ([#17](https://github.com/graemer-org/wick/issues/17)) ([44e38fe](https://github.com/graemer-org/wick/commit/44e38fe13583bdb947e2d032557522caf9624909))


### Bug Fixes

* budgets warn, never block — remove the enforce option ([#18](https://github.com/graemer-org/wick/issues/18)) ([13f70bc](https://github.com/graemer-org/wick/commit/13f70bc99b9d751885e70f88ee5621c943af2b2b))
* merge diverged notes refs in the pre-push hook ([#14](https://github.com/graemer-org/wick/issues/14)) ([54d188a](https://github.com/graemer-org/wick/commit/54d188af29fa2d7d3e7b60fd3e7273a1577f7370))

## [0.3.0](https://github.com/graemer-org/wick/compare/v0.2.0...v0.3.0) (2026-07-20)


### Features

* cost badge — wick badge command, publishing workflow, dogfooded in the README ([#7](https://github.com/graemer-org/wick/issues/7)) ([71e3b9c](https://github.com/graemer-org/wick/commit/71e3b9cd28181c12eaec32bef65506ad25bff23f))
* liven up the report and PR comment ([#5](https://github.com/graemer-org/wick/issues/5)) ([718abc3](https://github.com/graemer-org/wick/commit/718abc3d507ee92ff16ef054a78381e43ac3079a))

## [0.2.0](https://github.com/graemer-org/wick/compare/v0.1.0...v0.2.0) (2026-07-19)


### Features

* add attribution deltas, git notes storage, and chain-safe hook installer ([20dd00e](https://github.com/graemer-org/wick/commit/20dd00e24875baacb81170ba46f1cacf23c3fb24))
* add provider layer with Claude Code transcript parser and dedupe ([166bdc8](https://github.com/graemer-org/wick/commit/166bdc8d2a051af381cd03416362fc40ff5e9944))
* add report command, pricing tables, and CLI ([cf9d99a](https://github.com/graemer-org/wick/commit/cf9d99a04d8194bf342436819a064bb2172aa85f))
* break down costs by commit author ([2912054](https://github.com/graemer-org/wick/commit/2912054c4297a5e99d0db9faa94fff404fd0f404))
* reconcile stamps after squash and rebase merges ([f96dda8](https://github.com/graemer-org/wick/commit/f96dda8abdac19f7261a28836514935b19a99a56))


### Bug Fixes

* compute stamp deltas from cumulative session totals ([3b4d87e](https://github.com/graemer-org/wick/commit/3b4d87ebcadec8aee0a785ea98f1cddf0c0a845e))
* make session baselines monotonic across transcript rewrite races ([1b1fcf9](https://github.com/graemer-org/wick/commit/1b1fcf9b3d748d1a9f41e5bc0007bacd70dfd76e))
* set git identity before writing notes in CI reconcile ([6a2261f](https://github.com/graemer-org/wick/commit/6a2261fdacc1e5180107e242e101c85729858e82))
* skip notes push in pre-push hook when the push already includes the notes ref ([#3](https://github.com/graemer-org/wick/issues/3)) ([4ac11c0](https://github.com/graemer-org/wick/commit/4ac11c01f1f200b909f07d7d035f9ec1553a8a1b))
* unify author identities via .mailmap in the by-author breakdown ([891b2b8](https://github.com/graemer-org/wick/commit/891b2b8050f1aa7c1b8d00b9e14bcb9daf31dfc6))

## 0.1.0 (2026-07-19)

- Initial MVP: per-commit token stamping via git notes, `wick report`, sticky PR cost comment, squash/rebase merge reconciliation.
