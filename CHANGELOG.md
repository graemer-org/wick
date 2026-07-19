# Changelog

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
