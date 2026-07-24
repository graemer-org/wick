/**
 * Providers barrel + the default provider set wick ships with. This is the one
 * place allowed to name concrete providers; everything else threads an injected
 * `readonly UsageProvider[]` (see the provider-isolation invariant).
 */
import { createClaudeCodeProvider } from "./claude-code/index.js";
import { createCopilotCliProvider } from "./copilot-cli/index.js";
import type { UsageProvider } from "./types.js";

export { createClaudeCodeProvider } from "./claude-code/index.js";
export { createCopilotCliProvider } from "./copilot-cli/index.js";

/** The providers wick enables by default, in priority order. */
export function defaultProviders(): UsageProvider[] {
  return [createClaudeCodeProvider(), createCopilotCliProvider()];
}
