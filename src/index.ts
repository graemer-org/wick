/**
 * Library entry — side-effect-free. Importing this module must not parse argv
 * or register anything; that stays in `cli.ts` (the executable). Consumers
 * build their own `Wick` context and call the pieces directly.
 */
export type {
  ModelUsage,
  SessionRef,
  SessionUsage,
  GetUsageOptions,
  UsageProvider,
  CollectOptions,
  CollectResult,
} from "./providers/types.js";
export { collectUsage } from "./providers/types.js";
export {
  createClaudeCodeProvider,
  createCopilotCliProvider,
  defaultProviders,
} from "./providers/index.js";
export { createWick, type Wick } from "./wick.js";
export {
  computeDelta,
  emptyState,
  mergeNotes,
  mergeNoteVersions,
  type NoteData,
  type NoteSession,
  type StampState,
  type DeltaResult,
} from "./attribution.js";
export {
  buildReport,
  resolveRange,
  summarizeCost,
  evaluateBudget,
  type Report,
  type CostSummary,
} from "./report.js";
export { postCommit, postMerge, postRewrite, prePush } from "./hooks/index.js";
export { loadPricing, costUsd, type PricingTable } from "./pricing.js";
