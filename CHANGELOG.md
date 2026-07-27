# Changelog

## [0.7.0](https://github.com/graemer-org/wick/compare/v0.6.0...v0.7.0) (2026-07-27)


### Features

* capture AI cost for GitHub Actions runs ([#34](https://github.com/graemer-org/wick/issues/34)) ([9259e1d](https://github.com/graemer-org/wick/commit/9259e1da660d53c4c60fbada28365a601542cbf6))
* merge report and no-commit comments into one PR cost comment ([#51](https://github.com/graemer-org/wick/issues/51)) ([32bdc0a](https://github.com/graemer-org/wick/commit/32bdc0a8815575d66d2f5a681793c4e9256803c5))
* richer no-commit CI cost comment aligned with the report comment ([#44](https://github.com/graemer-org/wick/issues/44)) ([6c85cb8](https://github.com/graemer-org/wick/commit/6c85cb87fba0c650ed5a509fef1e8a7c59fe15f1))
* skip unchanged transcripts and prune stale baselines ([#38](https://github.com/graemer-org/wick/issues/38)) ([#52](https://github.com/graemer-org/wick/issues/52)) ([0a0d9ae](https://github.com/graemer-org/wick/commit/0a0d9ae7cb91c4d480429a4665d3aec72b319c51))


### Bug Fixes

* detect squash/rebase merge shape by patch-id, immune to base drift ([#47](https://github.com/graemer-org/wick/issues/47)) ([#49](https://github.com/graemer-org/wick/issues/49)) ([c238fd8](https://github.com/graemer-org/wick/commit/c238fd8175cecce2019339be6ba7b07d1468cdf4))
* fail on an unresolvable revision range instead of an empty report ([#38](https://github.com/graemer-org/wick/issues/38)) ([#53](https://github.com/graemer-org/wick/issues/53)) ([c505f1f](https://github.com/graemer-org/wick/commit/c505f1f0135bd8f7720357f06bf3e53e1418b6bc))
* label issues via GitHub MCP tool instead of sandboxed Bash ([#45](https://github.com/graemer-org/wick/issues/45)) ([2286d26](https://github.com/graemer-org/wick/commit/2286d2667f032f1e2064f7b3ca0cd9778d798f58)), closes [#40](https://github.com/graemer-org/wick/issues/40)
* make issue triage actually post its comment and labels ([#31](https://github.com/graemer-org/wick/issues/31)) ([6effa14](https://github.com/graemer-org/wick/commit/6effa142b39f00779b9b6b09f26c3f98dc3e8713))
* record [@claude](https://github.com/claude) base-sha from the PR head, not the checkout HEAD ([#46](https://github.com/graemer-org/wick/issues/46)) ([9ab4455](https://github.com/graemer-org/wick/commit/9ab44556c16a689326075a3580535cf482e56677))
* three correctness bugs in pricing, report totals, and reconcile push ([#42](https://github.com/graemer-org/wick/issues/42)) ([f86c3c1](https://github.com/graemer-org/wick/commit/f86c3c1b637bf85cabee426b68e097dca705a817))


### Performance Improvements

* batch note reads into two git spawns ([#39](https://github.com/graemer-org/wick/issues/39)) ([#57](https://github.com/graemer-org/wick/issues/57)) ([09d1c25](https://github.com/graemer-org/wick/commit/09d1c25c7a9f2b546714610b7c12ccedfa07aad0))
* serve full-history reports from an incremental rollup ([#39](https://github.com/graemer-org/wick/issues/39)) ([#58](https://github.com/graemer-org/wick/issues/58)) ([f59704f](https://github.com/graemer-org/wick/commit/f59704fe7bd925980b21c75a2f9d9999d1dcd86b))

## [0.6.0](https://github.com/graemer-org/wick/compare/v0.5.0...v0.6.0) (2026-07-20)


### Features

* auto-fetch notes on wick report so fresh checkouts show costs ([#27](https://github.com/graemer-org/wick/issues/27)) ([59a1e0b](https://github.com/graemer-org/wick/commit/59a1e0bec7d44036197632cf808555304085043a))
* expand pricing table with current Claude and Copilot models ([#28](https://github.com/graemer-org/wick/issues/28)) ([061f718](https://github.com/graemer-org/wick/commit/061f71880bcc4bd939ae14779855f9fc4fd71e9b))
* GitHub Copilot CLI usage provider ([#25](https://github.com/graemer-org/wick/issues/25)) ([4fe9065](https://github.com/graemer-org/wick/commit/4fe90659ad32f7f535ae7a1e0ea4aeff5dc074b9))

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
