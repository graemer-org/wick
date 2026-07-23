import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { costUsd, loadPricing } from "./pricing.js";

const table = loadPricing();
const oneMillion = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };

/** Cost of exactly 1M input tokens — a handy way to read back the input rate. */
function inputRate(provider: string, model: string): number | null {
  return costUsd(table, provider, model, oneMillion);
}

describe("bundled pricing.json", () => {
  it("prices current Claude Code models", () => {
    // Act + Assert
    expect(inputRate("claude-code", "claude-fable-5")).toBe(10);
    expect(inputRate("claude-code", "claude-opus-4-8")).toBe(5);
    expect(inputRate("claude-code", "claude-sonnet-4-5")).toBe(3);
    expect(inputRate("claude-code", "claude-haiku-4-5")).toBe(1);
  });

  it("prices legacy Opus 4.1 higher than the 4.5+ Opus family (longest prefix wins)", () => {
    // Act + Assert — claude-opus-4-1 must beat the broad claude-opus-4 entry.
    expect(inputRate("claude-code", "claude-opus-4-1-20250805")).toBe(15);
    expect(inputRate("claude-code", "claude-opus-4-5-20251101")).toBe(5);
  });

  it("prices Copilot CLI models by their dot-notation strings", () => {
    // Act + Assert — Copilot writes claude-opus-4.8 / gpt-5.3-codex (dots).
    expect(inputRate("copilot-cli", "claude-opus-4.8")).toBe(5);
    expect(inputRate("copilot-cli", "gpt-5.3-codex")).toBe(1.75);
    expect(inputRate("copilot-cli", "gpt-5.5")).toBe(5);
  });

  it("resolves gpt-5.4 sub-variants to their own rate, not the base", () => {
    // Act + Assert — gpt-5.4-mini/nano are longer prefixes than gpt-5.4.
    expect(inputRate("copilot-cli", "gpt-5.4")).toBe(2.5);
    expect(inputRate("copilot-cli", "gpt-5.4-mini")).toBe(0.75);
    expect(inputRate("copilot-cli", "gpt-5.4-nano")).toBe(0.2);
  });

  it("prices Sonnet 5 differently per provider (Copilot's intro rate vs Anthropic standard)", () => {
    // Act + Assert
    expect(inputRate("claude-code", "claude-sonnet-5")).toBe(3);
    expect(inputRate("copilot-cli", "claude-sonnet-5")).toBe(2);
  });

  it("sums all four token classes for a full Claude usage note", () => {
    // Arrange — Opus-tier rates: 5 / 0.5 / 6.25 / 25 per 1M.
    const tokens = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };

    // Act
    const cost = costUsd(table, "claude-code", "claude-opus-4-8", tokens);

    // Assert
    expect(cost).toBe(5 + 0.5 + 6.25 + 25);
  });

  it("returns null for an unknown model instead of guessing", () => {
    // Act + Assert
    expect(costUsd(table, "copilot-cli", "some-unreleased-model", oneMillion)).toBeNull();
    expect(costUsd(table, "no-such-provider", "claude-opus-4.8", oneMillion)).toBeNull();
  });
});

describe("malformed repo pricing override", () => {
  it("drops an entry missing a rate instead of pricing it as $NaN", () => {
    // Arrange — a hand-edited .wick/pricing.json entry that has `input` but no
    // `cacheWrite`. It must not survive the loader: costUsd would otherwise
    // multiply tokens by `undefined` → NaN and, since NaN !== null, render a
    // bogus known "$NaN" cost, violating "unknown → n/a, never guess".
    const repoRoot = mkdtempSync(path.join(tmpdir(), "wick-pricing-"));
    mkdirSync(path.join(repoRoot, ".wick"));
    writeFileSync(
      path.join(repoRoot, ".wick", "pricing.json"),
      JSON.stringify({
        "my-provider": [{ match: "custom-model", input: 5, cacheRead: 1, output: 10 }],
      }),
    );

    // Act
    const overridden = loadPricing(repoRoot);
    const cost = costUsd(overridden, "my-provider", "custom-model", {
      input: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    });

    // Assert — the incomplete entry was dropped, so the model reads as unknown.
    expect(overridden["my-provider"] ?? []).toHaveLength(0);
    expect(cost).toBeNull();
  });
});
