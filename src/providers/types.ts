/**
 * Provider-agnostic core types. Everything outside src/providers/ consumes
 * only these shapes — no provider-specific imports are allowed elsewhere.
 */

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
  /** Sessions whose transcripts touched this repo. */
  discoverSessions(repoRoot: string): Promise<SessionRef[]>;
  /** Deduped, per-model token usage for one session. */
  getUsage(session: SessionRef, opts?: GetUsageOptions): Promise<SessionUsage>;
}

export interface CollectOptions {
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
 * Collect current cumulative usage for all sessions of the given providers that
 * touched this repo. Providers are passed in explicitly (no process-global
 * registry) so one process can serve several repos/tenants concurrently. A
 * provider that fails never throws into the hook path — its error is swallowed
 * (optionally reported via onError).
 */
export async function collectUsage(
  providers: readonly UsageProvider[],
  repoRoot: string,
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const usage: SessionUsage[] = [];
  const discovered: SessionRef[] = [];
  for (const provider of providers) {
    try {
      const refs = await provider.discoverSessions(repoRoot);
      for (const ref of refs) {
        discovered.push(ref);
        try {
          usage.push(await provider.getUsage(ref, { since: opts.since }));
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
