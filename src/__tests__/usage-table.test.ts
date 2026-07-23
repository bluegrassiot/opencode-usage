import { describe, expect, test } from "bun:test";
import {
  renderUsageTable,
  getTableWidthTier,
} from "../dashboard/usage-table.js";
import type { DailyStats } from "../types.js";

describe("usage-table", () => {
  test("getTableWidthTier should return correct tiers", () => {
    expect(getTableWidthTier(50)).toBe("narrow");
    expect(getTableWidthTier(104)).toBe("narrow");
    expect(getTableWidthTier(105)).toBe("medium");
    expect(getTableWidthTier(139)).toBe("medium");
    expect(getTableWidthTier(140)).toBe("wide");
    expect(getTableWidthTier(200)).toBe("wide");
  });

  test("renderUsageTable should handle empty data", () => {
    const emptyMap = new Map<string, DailyStats>();
    const output = renderUsageTable(emptyMap);
    expect(output).toBe("No usage data");
  });

  test("renderUsageTable should render single day data (wide)", () => {
    const stats = new Map<string, DailyStats>();
    stats.set("2025-02-11", {
      date: "2025-02-11",
      models: new Set(["claude-opus-4-5"]),
      providers: new Set(["anthropic"]),
      providerStats: new Map(),
      sessionStats: new Map(),
      input: 1000000,
      output: 500000,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 123.45,
    });

    const output = renderUsageTable(stats, 180);
    expect(output).toContain("2025-02-11");
    expect(output).toContain("$123.45");
    expect(output).toContain("Total");
    expect(output).toContain("1.5M");
  });

  test("renderUsageTable should render narrow format", () => {
    const stats = new Map<string, DailyStats>();
    stats.set("2025-02-11", {
      date: "2025-02-11",
      models: new Set(["claude-opus-4-5"]),
      providers: new Set(["anthropic"]),
      providerStats: new Map(),
      sessionStats: new Map(),
      input: 100,
      output: 50,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 10.99,
    });

    const output = renderUsageTable(stats, 90);
    expect(output).toContain("Date");
    expect(output).toContain("Cost");
    expect(output).not.toContain("Models");
    expect(output).not.toContain("Tokens");
  });

  test("renderUsageTable should render medium format", () => {
    const stats = new Map<string, DailyStats>();
    stats.set("2025-02-11", {
      date: "2025-02-11",
      models: new Set(["gpt-4o"]),
      providers: new Set(["openai"]),
      providerStats: new Map(),
      sessionStats: new Map(),
      input: 500,
      output: 200,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 5.25,
    });

    const output = renderUsageTable(stats, 120);
    expect(output).toContain("Date");
    expect(output).toContain("Tokens");
    expect(output).toContain("Cost");
    expect(output).not.toContain("Models");
  });

  test("renderUsageTable should sort dates ascending", () => {
    const stats = new Map<string, DailyStats>();
    stats.set("2025-02-15", {
      date: "2025-02-15",
      models: new Set(),
      providers: new Set(),
      providerStats: new Map(),
      sessionStats: new Map(),
      input: 100,
      output: 50,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 1.0,
    });
    stats.set("2025-02-10", {
      date: "2025-02-10",
      models: new Set(),
      providers: new Set(),
      providerStats: new Map(),
      sessionStats: new Map(),
      input: 100,
      output: 50,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 1.0,
    });

    const output = renderUsageTable(stats, 180);
    const lines = output.split("\n");
    const date10Index = lines.findIndex((l) => l.includes("2025-02-10"));
    const date15Index = lines.findIndex((l) => l.includes("2025-02-15"));
    expect(date10Index).toBeLessThan(date15Index);
  });

  test("renderUsageTable should include totals row", () => {
    const stats = new Map<string, DailyStats>();
    stats.set("2025-02-11", {
      date: "2025-02-11",
      models: new Set(),
      providers: new Set(),
      providerStats: new Map(),
      sessionStats: new Map(),
      input: 1000,
      output: 500,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 10.0,
    });
    stats.set("2025-02-12", {
      date: "2025-02-12",
      models: new Set(),
      providers: new Set(),
      providerStats: new Map(),
      sessionStats: new Map(),
      input: 2000,
      output: 1000,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 20.0,
    });

    const output = renderUsageTable(stats, 180);
    expect(output).toContain("Total");
    expect(output).toContain("$30.00");
  });
});
