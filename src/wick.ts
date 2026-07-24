import type { UsageProvider } from "./providers/types.js";

/**
 * The explicit wick context, threaded through the stamp path instead of a
 * process-global provider registry. Holding the providers per-context (rather
 * than in a module singleton) is what lets one process serve several repos or
 * tenants with different provider configs concurrently — the structural reason
 * the singleton had to go (see #38).
 *
 * It is deliberately provider-agnostic: `createWick` takes an already-built
 * provider list so this module never imports concrete providers. The default
 * set lives at the composition root (`src/index.ts` / the CLI) via
 * `defaultProviders()`.
 */
export interface Wick {
  readonly providers: readonly UsageProvider[];
}

export function createWick(providers: readonly UsageProvider[]): Wick {
  return { providers };
}
