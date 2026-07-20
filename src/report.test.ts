import { describe, expect, it } from "vitest";
import {
  buildBadge,
  evaluateBudget,
  renderBadgeSvg,
  renderReport,
  type Report,
} from "./report.js";

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

describe("evaluateBudget", () => {
  const cfg = { pr: 20, warnAt: 0.8, enforce: false };

  it("is ok below the warn threshold", () => {
    expect(evaluateBudget(10, cfg)).toMatchObject({ status: "ok", usedFraction: 0.5 });
  });

  it("warns at exactly the warn fraction", () => {
    expect(evaluateBudget(16, cfg).status).toBe("warn");
  });

  it("stays warn at exactly 100% and flips over beyond it", () => {
    expect(evaluateBudget(20, cfg).status).toBe("warn");
    expect(evaluateBudget(20.01, cfg).status).toBe("over");
  });

  it("is unknown when the cost is unknown, and never enforces a guess", () => {
    const b = evaluateBudget(null, { ...cfg, enforce: true });
    expect(b.status).toBe("unknown");
    expect(b.usedUsd).toBeNull();
  });

  it("passes the enforce flag through", () => {
    expect(evaluateBudget(25, { ...cfg, enforce: true }).enforce).toBe(true);
  });
});

describe("renderReport budget line", () => {
  it("renders the budget bar when a budget is present", () => {
    const report = reportWithCost(18);
    report.budget = evaluateBudget(18, { pr: 20, warnAt: 0.8, enforce: false });
    const out = renderReport(report);
    expect(out).toContain("budget $20.00");
    expect(out).toContain("approaching budget");
  });

  it("shows the overage and enforcement", () => {
    const report = reportWithCost(25);
    report.budget = evaluateBudget(25, { pr: 20, warnAt: 0.8, enforce: true });
    const out = renderReport(report);
    expect(out).toContain("over by $5.00");
    expect(out).toContain("check fails");
  });
});

describe("renderBadgeSvg", () => {
  it("renders label, message, and mapped color", () => {
    const svg = renderBadgeSvg(buildBadge(reportWithCost(23.41)));
    expect(svg).toContain("<svg");
    expect(svg).toContain("$23.41 burned");
    expect(svg).toContain('fill="#97ca00"'); // green tier
    expect(svg).toContain("🕯️ wick");
  });

  it("escapes XML in the label", () => {
    const svg = renderBadgeSvg(buildBadge(reportWithCost(1), "<cost> & fire"));
    expect(svg).toContain("&lt;cost&gt; &amp; fire");
    expect(svg).not.toContain("<cost>");
  });
});
