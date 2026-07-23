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

export interface GetUsageOptions {
  /** Optional time window (legacy; the delta path never passes one). */
  window?: TimeWindow;
  /**
   * ISO mtime cutoff. A provider MAY skip re-reading a session whose transcript
   * has not changed since this instant and return empty usage instead — an
   * unchanged transcript has zero delta by the monotonic-baseline invariant, so
   * skipping it saves an O(file-size) read on every commit. Only the stamp path
   * passes this; read-only paths (`wick cost`) omit it to get full totals.
   *
   * The cutoff MUST be captured BEFORE reading transcripts (see postCommit): a
   * write that races our read then carries an mtime past the cutoff and is
   * re-read next commit, so no delta is ever lost — at worst deferred one commit.
   */
  since?: string;
}

export interface UsageProvider {
  readonly id: string;
  /** Sessions that touched this repo within the given time window. */
  discoverSessions(repoRoot: string, window: TimeWindow): Promise<SessionRef[]>;
  /** Deduped, per-model token usage for one session. */
  getUsage(session: SessionRef, opts?: GetUsageOptions): Promise<SessionUsage>;
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

export interface CollectOptions {
  window?: TimeWindow;
  /** Passed to each provider's getUsage to skip unchanged transcripts (stamp path). */
  since?: string;
  onError?: (providerId: string, err: unknown) => void;
}

export interface CollectResult {
  /** Current usage for every discovered session (empty perModel if skipped). */
  usage: SessionUsage[];
  /**
   * Every session that still exists on disk this run, straight from
   * discoverSessions — the set attribution prunes stale baselines against.
   * Kept separate from `usage` because a getUsage failure drops a session from
   * `usage` while the session (and its baseline) must survive.
   */
  discovered: SessionRef[];
}

/**
 * Collect current cumulative usage for all sessions of all registered
 * providers that touched this repo. A provider that fails never throws into
 * the hook path — its error is swallowed (optionally reported via onError).
 */
export async function collectUsage(
  repoRoot: string,
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const usage: SessionUsage[] = [];
  const discovered: SessionRef[] = [];
  for (const provider of getProviders()) {
    try {
      const refs = await provider.discoverSessions(repoRoot, opts.window ?? {});
      for (const ref of refs) {
        discovered.push(ref);
        try {
          usage.push(await provider.getUsage(ref, { window: opts.window, since: opts.since }));
        } catch (err) {
          opts.onError?.(provider.id, err);
        }
      }
    } catch (err) {
      opts.onError?.(provider.id, err);
    }
  }
  return { usage, discovered };
}
