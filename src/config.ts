import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Repo-committed wick configuration: <repoRoot>/.wick/config.json.
 * Same convention as the .wick/pricing.json override. Missing or corrupt
 * config never throws — wick simply behaves as if unconfigured.
 */

export interface BudgetConfig {
  /** PR budget in USD (applies to any branch/PR-scoped report range). */
  pr: number;
  /** Fraction of the budget at which the report starts warning. */
  warnAt: number;
  /** Fail the GitHub Action check when a PR exceeds the budget. */
  enforce: boolean;
}

export interface WickConfig {
  budget?: BudgetConfig;
}

export function loadConfig(repoRoot: string): WickConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(repoRoot, ".wick", "config.json"), "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const cfg: WickConfig = {};
  const budget = (raw as Record<string, unknown>).budget;
  if (budget && typeof budget === "object") {
    const b = budget as Record<string, unknown>;
    if (typeof b.pr === "number" && Number.isFinite(b.pr) && b.pr > 0) {
      const warnAt =
        typeof b.warnAt === "number" && b.warnAt > 0 && b.warnAt <= 1 ? b.warnAt : 0.8;
      cfg.budget = { pr: b.pr, warnAt, enforce: b.enforce === true };
    }
  }
  return cfg;
}
