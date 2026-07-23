import { describe, test, expect } from "bun:test";
import { renderJson, renderTable } from "../renderer.js";
import type { DailyStats } from "../types.js";
import type { JsonOutput } from "../renderer.js";

function createDailyStats(
  date: string,
  input: number = 1000,
  output: number = 500,
  cost: number = 5
): DailyStats {
  return {
    date,
    models: new Set(["claude-opus-4-5"]),
    providers: new Set(["anthropic"]),
    providerStats: new Map([
      [
        "anthropic",
        {
          input,
          output,
          cacheWrite: 0,
          cacheRead: 0,
          reasoning: 0,
          cost,
          models: new Set(["claude-opus-4-5"]),
          modelStats: new Map(),
        },
      ],
    ]),
    sessionStats: new Map(),
    input,
    output,
    cacheWrite: 0,
    cacheRead: 0,
    reasoning: 0,
    cost,
  };
}

describe("renderer", () => {
  describe("renderJson", () => {
    test("produces valid JSON structure for single day", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000, 500, 5)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output = msg;
      };

      renderJson(dailyStats);

      console.log = originalLog;

      const parsed: JsonOutput = JSON.parse(output);
      expect(parsed.periods).toBeDefined();
      expect(parsed.totals).toBeDefined();
      expect(parsed.periods.length).toBe(1);
    });

    test("includes period data with correct structure", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000, 500, 5)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output = msg;
      };

      renderJson(dailyStats);

      console.log = originalLog;

      const parsed: JsonOutput = JSON.parse(output);
      const period = parsed.periods[0];

      expect(period.date).toBe("2025-12-15");
      expect(period.models).toBeDefined();
      expect(Array.isArray(period.models)).toBe(true);
      expect(period.providers).toBeDefined();
      expect(Array.isArray(period.providers)).toBe(true);
      expect(period.totals).toBeDefined();
      expect(period.totals.input).toBe(1000);
      expect(period.totals.output).toBe(500);
      expect(period.totals.cost).toBeGreaterThan(0);
    });

    test("calculates correct totals for multiple days", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-14", createDailyStats("2025-12-14", 1000, 500, 5)],
        ["2025-12-15", createDailyStats("2025-12-15", 2000, 1000, 10)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output = msg;
      };

      renderJson(dailyStats);

      console.log = originalLog;

      const parsed: JsonOutput = JSON.parse(output);

      expect(parsed.periods.length).toBe(2);
      expect(parsed.totals.input).toBe(3000);
      expect(parsed.totals.output).toBe(1500);
    });

    test("sorts periods by date", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000, 500, 5)],
        ["2025-12-10", createDailyStats("2025-12-10", 2000, 1000, 10)],
        ["2025-12-12", createDailyStats("2025-12-12", 1500, 750, 7.5)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output = msg;
      };

      renderJson(dailyStats);

      console.log = originalLog;

      const parsed: JsonOutput = JSON.parse(output);

      expect(parsed.periods[0].date).toBe("2025-12-10");
      expect(parsed.periods[1].date).toBe("2025-12-12");
      expect(parsed.periods[2].date).toBe("2025-12-15");
    });

    test("includes provider information in output", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000, 500, 5)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output = msg;
      };

      renderJson(dailyStats);

      console.log = originalLog;

      const parsed: JsonOutput = JSON.parse(output);
      const period = parsed.periods[0];

      expect(period.providers.length).toBeGreaterThan(0);
      expect(period.providers[0].id).toBe("anthropic");
      expect(period.providers[0].models).toBeDefined();
      expect(period.providers[0].cost).toBeGreaterThan(0);
    });

    test("rounds costs to 2 decimal places", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000, 500, 5.123456)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output = msg;
      };

      renderJson(dailyStats);

      console.log = originalLog;

      const parsed: JsonOutput = JSON.parse(output);
      const period = parsed.periods[0];

      expect(period.totals.cost).toBe(5.12);
    });
  });

  describe("renderTable", () => {
    test("renders table without errors for single day", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000, 500, 5)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output += msg + "\n";
      };

      renderTable(dailyStats);

      console.log = originalLog;

      expect(output).toContain("2025-12-15");
      expect(output).toContain("claude-opus-4-5");
      expect(output).toContain("anthropic");
    });

    test("renders table with multiple days", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-14", createDailyStats("2025-12-14", 1000, 500, 5)],
        ["2025-12-15", createDailyStats("2025-12-15", 2000, 1000, 10)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output += msg + "\n";
      };

      renderTable(dailyStats);

      console.log = originalLog;

      expect(output).toContain("2025-12-14");
      expect(output).toContain("2025-12-15");
      expect(output).toContain("Total");
    });

    test("includes table borders", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000, 500, 5)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output += msg + "\n";
      };

      renderTable(dailyStats);

      console.log = originalLog;

      expect(output).toContain("┌");
      expect(output).toContain("┐");
      expect(output).toContain("└");
      expect(output).toContain("┘");
      expect(output).toContain("│");
    });

    test("includes column headers", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000, 500, 5)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output += msg + "\n";
      };

      renderTable(dailyStats);

      console.log = originalLog;

      expect(output).toContain("Date");
      expect(output).toContain("Models");
      expect(output).toContain("Input");
      expect(output).toContain("Output");
      expect(output).toContain("Cost");
    });

    test("formats numbers with commas", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000000, 500000, 5)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output += msg + "\n";
      };

      renderTable(dailyStats);

      console.log = originalLog;

      expect(output).toContain("1,000,000");
      expect(output).toContain("500,000");
    });

    test("formats costs with dollar sign", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-15", createDailyStats("2025-12-15", 1000, 500, 5.5)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output += msg + "\n";
      };

      renderTable(dailyStats);

      console.log = originalLog;

      expect(output).toContain("$");
    });

    test("handles empty data gracefully", () => {
      const dailyStats = new Map<string, DailyStats>();

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output += msg + "\n";
      };

      renderTable(dailyStats);

      console.log = originalLog;

      expect(output).toContain("No usage data found");
    });

    test("includes total row", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-14", createDailyStats("2025-12-14", 1000, 500, 5)],
        ["2025-12-15", createDailyStats("2025-12-15", 2000, 1000, 10)],
      ]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output += msg + "\n";
      };

      renderTable(dailyStats);

      console.log = originalLog;

      expect(output).toContain("Total");
      expect(output).toContain("3,000");
      expect(output).toContain("1,500");
    });

    test("displays provider breakdown", () => {
      const stats = createDailyStats("2025-12-15", 1000, 500, 5);
      const dailyStats = new Map<string, DailyStats>([["2025-12-15", stats]]);

      let output = "";
      const originalLog = console.log;
      console.log = (msg: string) => {
        output += msg + "\n";
      };

      renderTable(dailyStats);

      console.log = originalLog;

      expect(output).toContain("[anthropic]");
    });
  });
});
