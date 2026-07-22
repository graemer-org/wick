import { describe, expect, it } from "vitest";
import { buildBadge, evaluateBudget, renderBadgeSvg, renderReport } from "./report.js";
import { TestFactory } from "./test-factory.js";

describe("buildBadge", () => {
  it("renders the cost as the badge message", () => {
    // Act
    const badge = buildBadge(TestFactory.makeReport(23.412));

    // Assert
    expect(badge).toEqual({
      schemaVersion: 1,
      label: "🕯️ wick",
      message: "$23.41 burned",
      color: "green",
    });
  });

  it("heats up the color with spend", () => {
    // Act + Assert
    expect(buildBadge(TestFactory.makeReport(0)).color).toBe("brightgreen");
    expect(buildBadge(TestFactory.makeReport(10)).color).toBe("green");
    expect(buildBadge(TestFactory.makeReport(100)).color).toBe("yellow");
    expect(buildBadge(TestFactory.makeReport(500)).color).toBe("orange");
    expect(buildBadge(TestFactory.makeReport(2000)).color).toBe("red");
  });

  it("shows grey n/a when the cost is unknown", () => {
    // Act
    const badge = buildBadge(TestFactory.makeReport(null));

    // Assert
    expect(badge).toEqual({
      schemaVersion: 1,
      label: "🕯️ wick",
      message: "n/a",
      color: "lightgrey",
    });
  });

  it("accepts a custom label", () => {
    // Act + Assert
    expect(buildBadge(TestFactory.makeReport(1), "AI spend").label).toBe("AI spend");
  });

  it("marks a lower-bound cost with ≥ and caps the color at yellow", () => {
    // Arrange — a range containing a model without pricing: the total is a
    // lower bound, so the badge must not read as a reassuring green.
    const lowerBoundReport = TestFactory.makeReport(3.08, ["claude-code/claude-future-1"]);

    // Act
    const badge = buildBadge(lowerBoundReport);

    // Assert
    expect(badge).toEqual({
      schemaVersion: 1,
      label: "🕯️ wick",
      message: "≥ $3.08 burned",
      color: "yellow",
    });
  });

  it("keeps hotter-than-yellow colors on a lower bound", () => {
    // Arrange
    const unknownModels = ["claude-code/claude-future-1"];

    // Act + Assert — green tiers cap at yellow; yellow and hotter stay put.
    expect(buildBadge(TestFactory.makeReport(23.41, unknownModels)).color).toBe("yellow");
    expect(buildBadge(TestFactory.makeReport(100, unknownModels)).color).toBe("yellow");
    expect(buildBadge(TestFactory.makeReport(500, unknownModels)).color).toBe("orange");
    expect(buildBadge(TestFactory.makeReport(2000, unknownModels)).color).toBe("red");
  });
});

describe("evaluateBudget", () => {
  const budgetConfig = { pr: 20, warnAt: 0.8 };

  it("is ok below the warn threshold", () => {
    // Act
    const budget = evaluateBudget(10, budgetConfig);

    // Assert
    expect(budget).toMatchObject({ status: "ok", usedFraction: 0.5 });
  });

  it("warns at exactly the warn fraction", () => {
    // Act + Assert
    expect(evaluateBudget(16, budgetConfig).status).toBe("warn");
  });

  it("stays warn at exactly 100% and flips over beyond it", () => {
    // Act + Assert
    expect(evaluateBudget(20, budgetConfig).status).toBe("warn");
    expect(evaluateBudget(20.01, budgetConfig).status).toBe("over");
  });

  it("is unknown when the cost is unknown", () => {
    // Act
    const budget = evaluateBudget(null, budgetConfig);

    // Assert
    expect(budget.status).toBe("unknown");
    expect(budget.usedUsd).toBeNull();
  });
});

describe("renderReport budget line", () => {
  it("renders the budget bar when a budget is present", () => {
    // Arrange
    const report = TestFactory.makeReport(18);
    report.budget = evaluateBudget(18, { pr: 20, warnAt: 0.8 });

    // Act
    const renderedReport = renderReport(report);

    // Assert
    expect(renderedReport).toContain("budget $20.00");
    expect(renderedReport).toContain("approaching budget");
  });

  it("shows the overage without any enforcement language", () => {
    // Arrange
    const report = TestFactory.makeReport(25);
    report.budget = evaluateBudget(25, { pr: 20, warnAt: 0.8 });

    // Act
    const renderedReport = renderReport(report);

    // Assert
    expect(renderedReport).toContain("over by $5.00");
    expect(renderedReport).not.toContain("check fails");
  });
});

describe("renderBadgeSvg", () => {
  it("renders label, message, and mapped color", () => {
    // Act
    const renderedSvg = renderBadgeSvg(buildBadge(TestFactory.makeReport(23.41)));

    // Assert
    expect(renderedSvg).toContain("<svg");
    expect(renderedSvg).toContain("$23.41 burned");
    expect(renderedSvg).toContain('fill="#97ca00"'); // green tier
    expect(renderedSvg).toContain("🕯️ wick");
  });

  it("escapes XML in the label", () => {
    // Act
    const renderedSvg = renderBadgeSvg(buildBadge(TestFactory.makeReport(1), "<cost> & fire"));

    // Assert
    expect(renderedSvg).toContain("&lt;cost&gt; &amp; fire");
    expect(renderedSvg).not.toContain("<cost>");
  });
});
