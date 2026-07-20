import { describe, expect, it } from "vitest";
import { buildBadge, type Report } from "./report.js";

function reportWithCost(costUsd: number | null): Report {
  return {
    range: "HEAD",
    commits: [],
    authors: [],
    totals: {
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      costUsd,
      sessions: 0,
      stampedCommits: 0,
      commits: 0,
    },
    unknownModels: [],
  };
}

describe("buildBadge", () => {
  it("renders the cost as the badge message", () => {
    expect(buildBadge(reportWithCost(23.412))).toEqual({
      schemaVersion: 1,
      label: "🕯️ wick",
      message: "$23.41 burned",
      color: "green",
    });
  });

  it("heats up the color with spend", () => {
    expect(buildBadge(reportWithCost(0)).color).toBe("brightgreen");
    expect(buildBadge(reportWithCost(10)).color).toBe("green");
    expect(buildBadge(reportWithCost(100)).color).toBe("yellow");
    expect(buildBadge(reportWithCost(500)).color).toBe("orange");
    expect(buildBadge(reportWithCost(2000)).color).toBe("red");
  });

  it("shows grey n/a when the cost is unknown", () => {
    expect(buildBadge(reportWithCost(null))).toEqual({
      schemaVersion: 1,
      label: "🕯️ wick",
      message: "n/a",
      color: "lightgrey",
    });
  });

  it("accepts a custom label", () => {
    expect(buildBadge(reportWithCost(1), "AI spend").label).toBe("AI spend");
  });
});
