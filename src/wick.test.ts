import { describe, expect, it } from "vitest";
import { createWick, defaultProviders } from "./index.js";
import type { UsageProvider } from "./index.js";

const stubProvider = (id: string): UsageProvider => ({
  id,
  async discoverSessions() {
    return [];
  },
  async getUsage() {
    throw new Error("unused in this test");
  },
});

describe("wick library context", () => {
  it("ships the claude-code and copilot-cli providers by default", () => {
    // Act
    const ids = defaultProviders()
      .map((provider) => provider.id)
      .sort();

    // Assert
    expect(ids).toEqual(["claude-code", "copilot-cli"]);
  });

  it("holds exactly the injected providers, with no shared global registry", () => {
    // Arrange — two independent contexts, as two repos/tenants would build.
    const tenantA = createWick([stubProvider("a")]);
    const tenantB = createWick([stubProvider("b1"), stubProvider("b2")]);

    // Act + Assert — neither context leaks into the other.
    expect(tenantA.providers.map((p) => p.id)).toEqual(["a"]);
    expect(tenantB.providers.map((p) => p.id)).toEqual(["b1", "b2"]);
  });
});
