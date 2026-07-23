import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface PriceEntry {
  match: string; // model-name prefix
  input: number; // USD per 1M tokens
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export type PricingTable = Record<string, PriceEntry[]>;

function bundledPricingPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/pricing.ts -> ../pricing.json (package root)
  return path.join(here, "..", "pricing.json");
}

function sanitize(raw: unknown): PricingTable {
  const table: PricingTable = {};
  if (raw && typeof raw === "object") {
    for (const [provider, entries] of Object.entries(raw as Record<string, unknown>)) {
      if (provider.startsWith("_") || !Array.isArray(entries)) continue;
      table[provider] = entries.filter(
        (e): e is PriceEntry =>
          e &&
          typeof e.match === "string" &&
          Number.isFinite(e.input) &&
          Number.isFinite(e.cacheRead) &&
          Number.isFinite(e.cacheWrite) &&
          Number.isFinite(e.output),
      );
    }
  }
  return table;
}

/**
 * Bundled pricing, optionally overlaid with <repoRoot>/.wick/pricing.json.
 * Repo entries for a provider are consulted before bundled ones.
 */
export function loadPricing(repoRoot?: string): PricingTable {
  let table: PricingTable = {};
  try {
    table = sanitize(JSON.parse(readFileSync(bundledPricingPath(), "utf8")));
  } catch {
    // missing bundled pricing — all costs become n/a
  }
  if (repoRoot) {
    try {
      const override = sanitize(
        JSON.parse(
          readFileSync(path.join(repoRoot, ".wick", "pricing.json"), "utf8"),
        ),
      );
      for (const [provider, entries] of Object.entries(override)) {
        table[provider] = [...entries, ...(table[provider] ?? [])];
      }
    } catch {
      // no override — fine
    }
  }
  return table;
}

export interface TokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * Cost in USD, or null when the model is unknown (never guess).
 * Longest matching prefix wins within a provider.
 */
export function costUsd(
  table: PricingTable,
  provider: string,
  model: string,
  tokens: TokenCounts,
): number | null {
  const entries = table[provider] ?? [];
  let best: PriceEntry | null = null;
  for (const e of entries) {
    if (model.startsWith(e.match) && (!best || e.match.length > best.match.length)) {
      best = e;
    }
  }
  if (!best) return null;
  return (
    (tokens.input * best.input +
      tokens.cacheRead * best.cacheRead +
      tokens.cacheWrite * best.cacheWrite +
      tokens.output * best.output) /
    1_000_000
  );
}
