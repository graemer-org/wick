/**
 * Provider-agnostic core types. Everything outside src/providers/ consumes
 * only these shapes — no provider-specific imports are allowed elsewhere.
 */

export interface TimeWindow {
  /** ISO timestamp, inclusive lower bound. Omit for "since forever". */
  start?: string;
  /** ISO timestamp, inclusive upper bound. Omit for "until now". */
  end?: string;
}

export interface SessionRef {
  /** Stable session identifier (e.g. the transcript's session UUID). */
  id: string;
  /** Provider id this ref belongs to. */
  provider: string;
  /** Provider-private locator (e.g. a file path). Opaque to the core. */
  path: string;
}

export interface ModelUsage {
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface SessionUsage {
  sessionId: string;
  provider: string;
  perModel: ModelUsage[];
  firstTs: string; // ISO
  lastTs: string; // ISO
}

export interface UsageProvider {
  readonly id: string;
  /** Sessions that touched this repo within the given time window. */
  discoverSessions(repoRoot: string, window: TimeWindow): Promise<SessionRef[]>;
  /** Deduped, per-model token usage for one session, optionally bounded by time. */
  getUsage(session: SessionRef, window?: TimeWindow): Promise<SessionUsage>;
}

const registry: UsageProvider[] = [];

export function registerProvider(provider: UsageProvider): void {
  if (!registry.some((p) => p.id === provider.id)) {
    registry.push(provider);
  }
}

export function getProviders(): readonly UsageProvider[] {
  return registry;
}

/** Test helper: reset the registry. */
export function clearProviders(): void {
  registry.length = 0;
}

/**
 * Collect current cumulative usage for all sessions of all registered
 * providers that touched this repo. A provider that fails never throws into
 * the hook path — its error is swallowed (optionally reported via onError).
 */
export async function collectUsage(
  repoRoot: string,
  window: TimeWindow,
  onError?: (providerId: string, err: unknown) => void,
): Promise<SessionUsage[]> {
  const out: SessionUsage[] = [];
  for (const provider of getProviders()) {
    try {
      const refs = await provider.discoverSessions(repoRoot, window);
      for (const ref of refs) {
        try {
          out.push(await provider.getUsage(ref, window));
        } catch (err) {
          onError?.(provider.id, err);
        }
      }
    } catch (err) {
      onError?.(provider.id, err);
    }
  }
  return out;
}
