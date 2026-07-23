import { describe, test, expect } from "bun:test";
import {
  aggregateByDate,
  filterByDays,
  filterByDateRange,
  aggregateByMonth,
  buildParentTrees,
} from "../aggregator.js";
import type {
  MessageJson,
  DailyStats,
  SessionStats,
  ProviderStats,
  ParentTreeNode,
} from "../types.js";
import type { SessionInfo } from "../loader.js";
import { calculateCost } from "../pricing.js";

function createMessage(
  modelId: string,
  providerId: string,
  timestamp: number,
  input: number = 1000,
  output: number = 500,
  sessionID: string = "session-1",
  cacheWrite: number = 0,
  cacheRead: number = 0,
  reasoning: number = 0
): MessageJson {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    sessionID,
    role: "assistant",
    model: {
      modelID: modelId,
      providerID: providerId,
    },
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
    },
    time: {
      created: timestamp,
      completed: timestamp,
    },
  };
}

function createMessageNoSession(
  modelId: string,
  providerId: string,
  timestamp: number,
  input: number = 1000,
  output: number = 500,
  cacheWrite: number = 0,
  cacheRead: number = 0,
  reasoning: number = 0
): MessageJson {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    sessionID: "",
    role: "assistant",
    model: { modelID: modelId, providerID: providerId },
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
    },
    time: { created: timestamp, completed: timestamp },
  };
}

function createDailyStats(
  date: string,
  models: string[] = [],
  providers: string[] = [],
  input: number = 0,
  output: number = 0,
  cost: number = 0
): DailyStats {
  return {
    date,
    models: new Set(models),
    providers: new Set(providers),
    providerStats: new Map(),
    sessionStats: new Map(),
    input,
    output,
    cacheWrite: 0,
    cacheRead: 0,
    reasoning: 0,
    cost,
  };
}

function createSessionInfo(
  id: string,
  title: string,
  parentId: string | null = null,
  agent: string | null = null
): SessionInfo {
  return {
    id,
    title,
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    parentId,
    agent,
  };
}

function createSessionStats(
  sessionID: string,
  input: number,
  output: number,
  cost: number,
  providerId: string = "anthropic",
  modelId: string = "claude-opus-4-5"
): SessionStats {
  const ss: SessionStats = {
    sessionID,
    input,
    output,
    cacheWrite: 0,
    cacheRead: 0,
    reasoning: 0,
    cost,
    providerStats: new Map(),
  };
  const ps: ProviderStats = {
    input,
    output,
    cacheWrite: 0,
    cacheRead: 0,
    reasoning: 0,
    cost,
    models: new Set([modelId]),
    modelStats: new Map(),
  };
  ps.modelStats.set(modelId, {
    input,
    output,
    cacheWrite: 0,
    cacheRead: 0,
    reasoning: 0,
    cost,
  });
  ss.providerStats.set(providerId, ps);
  return ss;
}

describe("aggregator", () => {
  describe("aggregateByDate", () => {
    test("populates session providerStats with provider/model breakdown", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const msg = createMessage(
        "claude-opus-4-5",
        "anthropic",
        timestamp,
        1000,
        500,
        "ses-1"
      );
      const result = aggregateByDate([msg]);
      const session = result.get("2025-12-15")!.sessionStats.get("ses-1")!;

      expect(session.providerStats).toBeInstanceOf(Map);
      expect(session.providerStats.size).toBe(1);
      const provider = session.providerStats.get("anthropic")!;
      expect(provider.input).toBe(1000);
      expect(provider.output).toBe(500);
      expect(provider.modelStats.size).toBe(1);
      expect(provider.modelStats.get("claude-opus-4-5")!.input).toBe(1000);
    });
    test("aggregates single message by date", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const messages = [
        createMessage("claude-opus-4-5", "anthropic", timestamp),
      ];

      const result = aggregateByDate(messages);

      expect(result.size).toBe(1);
      expect(result.has("2025-12-15")).toBe(true);

      const stats = result.get("2025-12-15")!;
      expect(stats.input).toBe(1000);
      expect(stats.output).toBe(500);
      expect(stats.models.has("claude-opus-4-5")).toBe(true);
      expect(stats.providers.has("anthropic")).toBe(true);
    });

    test("aggregates multiple messages on same day", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const messages = [
        createMessage("claude-opus-4-5", "anthropic", timestamp, 1000, 500),
        createMessage("claude-sonnet-4-5", "anthropic", timestamp, 2000, 1000),
      ];

      const result = aggregateByDate(messages);

      const stats = result.get("2025-12-15")!;
      expect(stats.input).toBe(3000);
      expect(stats.output).toBe(1500);
      expect(stats.models.size).toBe(2);
      expect(stats.providers.size).toBe(1);
    });

    test("separates messages by date", () => {
      const timestamp1 = new Date("2025-12-15").getTime();
      const timestamp2 = new Date("2025-12-16").getTime();
      const messages = [
        createMessage("claude-opus-4-5", "anthropic", timestamp1, 1000, 500),
        createMessage("claude-opus-4-5", "anthropic", timestamp2, 2000, 1000),
      ];

      const result = aggregateByDate(messages);

      expect(result.size).toBe(2);
      expect(result.get("2025-12-15")!.input).toBe(1000);
      expect(result.get("2025-12-16")!.input).toBe(2000);
    });

    test("aggregates by provider within a day", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const messages = [
        createMessage("claude-opus-4-5", "anthropic", timestamp, 1000, 500),
        createMessage("gpt-4o", "openai", timestamp, 2000, 1000),
      ];

      const result = aggregateByDate(messages);

      const stats = result.get("2025-12-15")!;
      expect(stats.providerStats.size).toBe(2);
      expect(stats.providerStats.get("anthropic")!.input).toBe(1000);
      expect(stats.providerStats.get("openai")!.input).toBe(2000);
    });

    test("tracks per-model stats within a provider", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const messages = [
        createMessage("grok-4.5", "openrouter", timestamp, 1000, 500),
        createMessage("grok-4.5", "openrouter", timestamp, 2000, 1000),
        createMessage("deepseek-v4-pro", "openrouter", timestamp, 4000, 2000),
      ];

      const result = aggregateByDate(messages);
      const provider = result
        .get("2025-12-15")!
        .providerStats.get("openrouter")!;

      expect(provider.modelStats.size).toBe(2);
      expect(provider.modelStats.get("grok-4.5")!.input).toBe(3000);
      expect(provider.modelStats.get("grok-4.5")!.output).toBe(1500);
      expect(provider.modelStats.get("deepseek-v4-pro")!.input).toBe(4000);

      // Per-model metrics sum to the provider total
      const models = [...provider.modelStats.values()];
      expect(models.reduce((s, m) => s + m.input, 0)).toBe(provider.input);
      expect(models.reduce((s, m) => s + m.output, 0)).toBe(provider.output);
      expect(models.reduce((s, m) => s + m.cacheWrite, 0)).toBe(
        provider.cacheWrite
      );
      expect(models.reduce((s, m) => s + m.cacheRead, 0)).toBe(
        provider.cacheRead
      );
      expect(models.reduce((s, m) => s + m.reasoning, 0)).toBe(
        provider.reasoning
      );
      expect(models.reduce((s, m) => s + m.cost, 0)).toBeCloseTo(
        provider.cost,
        10
      );
    });

    test("handles messages without timestamp", () => {
      const messages: MessageJson[] = [
        {
          id: "msg-1",
          sessionID: "session-1",
          role: "assistant",
          tokens: {
            input: 1000,
            output: 500,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      ];

      const result = aggregateByDate(messages);
      expect(result.size).toBe(0);
    });

    test("calculates cost correctly during aggregation", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const messages = [
        createMessage("claude-opus-4-5", "anthropic", timestamp, 1_000_000, 0),
      ];

      const result = aggregateByDate(messages);
      const stats = result.get("2025-12-15")!;

      expect(stats.cost).toBeGreaterThan(0);
      expect(stats.cost).toBeLessThan(10);
    });

    test("aggregates multiple sessions with full token fields", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const msg1 = createMessage(
        "claude-opus-4-5",
        "anthropic",
        timestamp,
        1000,
        500,
        "session-A",
        100,
        200,
        300
      );
      const msg2 = createMessage(
        "claude-sonnet-4-5",
        "anthropic",
        timestamp,
        2000,
        1000,
        "session-A",
        150,
        300,
        400
      );
      const msg3 = createMessage(
        "gpt-4o",
        "openai",
        timestamp,
        3000,
        1500,
        "session-B",
        50,
        100,
        200
      );

      const result = aggregateByDate([msg1, msg2, msg3]);
      const stats = result.get("2025-12-15")!;

      expect(stats.sessionStats).toBeInstanceOf(Map);
      expect(stats.sessionStats.size).toBe(2);
      expect(stats.sessionStats.has("session-A")).toBe(true);
      expect(stats.sessionStats.has("session-B")).toBe(true);

      const sessionA = stats.sessionStats.get("session-A")!;
      const expectedCostA =
        calculateCost(msg1.tokens!, "claude-opus-4-5") +
        calculateCost(msg2.tokens!, "claude-sonnet-4-5");
      expect(sessionA.sessionID).toBe("session-A");
      expect(sessionA.input).toBe(3000);
      expect(sessionA.output).toBe(1500);
      expect(sessionA.cacheWrite).toBe(250);
      expect(sessionA.cacheRead).toBe(500);
      expect(sessionA.reasoning).toBe(700);
      expect(sessionA.cost).toBeCloseTo(expectedCostA, 10);

      const sessionB = stats.sessionStats.get("session-B")!;
      const expectedCostB = calculateCost(msg3.tokens!, "gpt-4o");
      expect(sessionB.sessionID).toBe("session-B");
      expect(sessionB.input).toBe(3000);
      expect(sessionB.output).toBe(1500);
      expect(sessionB.cacheWrite).toBe(50);
      expect(sessionB.cacheRead).toBe(100);
      expect(sessionB.reasoning).toBe(200);
      expect(sessionB.cost).toBeCloseTo(expectedCostB, 10);
    });

    test("same session across multiple days has independent per-day totals", () => {
      const ts1 = new Date("2025-12-15").getTime();
      const ts2 = new Date("2025-12-16").getTime();
      const msg1 = createMessage(
        "claude-opus-4-5",
        "anthropic",
        ts1,
        1000,
        500,
        "ses-X",
        100,
        200,
        300
      );
      const msg2 = createMessage(
        "claude-opus-4-5",
        "anthropic",
        ts2,
        2000,
        1000,
        "ses-X",
        150,
        300,
        400
      );

      const result = aggregateByDate([msg1, msg2]);

      const day1 = result.get("2025-12-15")!.sessionStats.get("ses-X")!;
      const day2 = result.get("2025-12-16")!.sessionStats.get("ses-X")!;

      expect(day1.input).toBe(1000);
      expect(day1.output).toBe(500);
      expect(day1.cacheWrite).toBe(100);
      expect(day1.cacheRead).toBe(200);
      expect(day1.reasoning).toBe(300);
      expect(day1.cost).toBeCloseTo(
        calculateCost(msg1.tokens!, "claude-opus-4-5"),
        10
      );

      expect(day2.input).toBe(2000);
      expect(day2.output).toBe(1000);
      expect(day2.cacheWrite).toBe(150);
      expect(day2.cacheRead).toBe(300);
      expect(day2.reasoning).toBe(400);
      expect(day2.cost).toBeCloseTo(
        calculateCost(msg2.tokens!, "claude-opus-4-5"),
        10
      );
    });

    test("messages with empty sessionID are grouped under __unknown__", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const msg = createMessage(
        "claude-opus-4-5",
        "anthropic",
        timestamp,
        1000,
        500,
        "",
        100,
        200,
        300
      );

      const result = aggregateByDate([msg]);
      const stats = result.get("2025-12-15")!;

      // Changed: now grouped under __unknown__ instead of omitted
      expect(stats.sessionStats.size).toBe(1);
      expect(stats.sessionStats.has("__unknown__")).toBe(true);
      const unknown = stats.sessionStats.get("__unknown__")!;
      expect(unknown.sessionID).toBe("__unknown__");
      expect(unknown.input).toBe(1000);
      expect(unknown.output).toBe(500);

      // Daily totals unchanged
      const expectedCost = calculateCost(msg.tokens!, "claude-opus-4-5");
      expect(stats.input).toBe(1000);
      expect(stats.output).toBe(500);
      expect(stats.cacheWrite).toBe(100);
      expect(stats.cacheRead).toBe(200);
      expect(stats.reasoning).toBe(300);
      expect(stats.cost).toBeCloseTo(expectedCost, 10);
    });

    test("session totals sum to daily totals", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const msg1 = createMessage(
        "claude-opus-4-5",
        "anthropic",
        timestamp,
        1000,
        500,
        "session-A",
        100,
        200,
        300
      );
      const msg2 = createMessage(
        "gpt-4o",
        "openai",
        timestamp,
        2000,
        1000,
        "session-B",
        50,
        100,
        200
      );

      const result = aggregateByDate([msg1, msg2]);
      const stats = result.get("2025-12-15")!;
      const sessions = [...stats.sessionStats.values()];

      expect(sessions.reduce((s, ss) => s + ss.input, 0)).toBe(stats.input);
      expect(sessions.reduce((s, ss) => s + ss.output, 0)).toBe(stats.output);
      expect(sessions.reduce((s, ss) => s + ss.cacheWrite, 0)).toBe(
        stats.cacheWrite
      );
      expect(sessions.reduce((s, ss) => s + ss.cacheRead, 0)).toBe(
        stats.cacheRead
      );
      expect(sessions.reduce((s, ss) => s + ss.reasoning, 0)).toBe(
        stats.reasoning
      );
      expect(sessions.reduce((s, ss) => s + ss.cost, 0)).toBeCloseTo(
        stats.cost,
        10
      );
    });

    test("retains zero-cost session in sessionStats for free models", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const msg = createMessage(
        "qwen3-coder",
        "opencode",
        timestamp,
        500,
        200,
        "ses-free",
        0,
        0,
        0
      );

      const result = aggregateByDate([msg]);
      const stats = result.get("2025-12-15")!;

      expect(stats.sessionStats.size).toBe(1);
      const session = stats.sessionStats.get("ses-free")!;
      expect(session.sessionID).toBe("ses-free");
      expect(session.input).toBe(500);
      expect(session.output).toBe(200);
      expect(session.cacheWrite).toBe(0);
      expect(session.cacheRead).toBe(0);
      expect(session.reasoning).toBe(0);
      expect(session.cost).toBe(0);
    });

    test("populates session-level providerStats with correct token sums", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const msg1 = createMessage(
        "claude-opus-4-5",
        "anthropic",
        timestamp,
        1000,
        500,
        "ses-1"
      );
      const msg2 = createMessage(
        "gpt-4o",
        "openai",
        timestamp,
        2000,
        1000,
        "ses-1"
      );

      const result = aggregateByDate([msg1, msg2]);
      const session = result.get("2025-12-15")!.sessionStats.get("ses-1")!;

      expect(session.providerStats.size).toBe(2);
      expect(session.providerStats.get("anthropic")!.input).toBe(1000);
      expect(session.providerStats.get("anthropic")!.output).toBe(500);
      expect(session.providerStats.get("openai")!.input).toBe(2000);
      expect(session.providerStats.get("openai")!.output).toBe(1000);
    });

    test("populates session-level modelStats within providers", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const msg1 = createMessage(
        "claude-opus-4-5",
        "anthropic",
        timestamp,
        1000,
        500,
        "ses-1"
      );
      const msg2 = createMessage(
        "claude-sonnet-4-5",
        "anthropic",
        timestamp,
        2000,
        1000,
        "ses-1"
      );

      const result = aggregateByDate([msg1, msg2]);
      const session = result.get("2025-12-15")!.sessionStats.get("ses-1")!;
      const provider = session.providerStats.get("anthropic")!;

      expect(provider.modelStats.size).toBe(2);
      expect(provider.modelStats.get("claude-opus-4-5")!.input).toBe(1000);
      expect(provider.modelStats.get("claude-sonnet-4-5")!.input).toBe(2000);
    });

    test("session provider modelStats sums reconcile with provider totals", () => {
      const timestamp = new Date("2025-12-15").getTime();
      // Two models under same provider, same session, with non-zero cache/reasoning
      const msg1 = createMessage(
        "claude-opus-4-5",
        "anthropic",
        timestamp,
        1000,
        500,
        "ses-1",
        100,
        200,
        50
      );
      const msg2 = createMessage(
        "claude-sonnet-4-5",
        "anthropic",
        timestamp,
        2000,
        1000,
        "ses-1",
        150,
        300,
        80
      );

      const result = aggregateByDate([msg1, msg2]);
      const session = result.get("2025-12-15")!.sessionStats.get("ses-1")!;
      const provider = session.providerStats.get("anthropic")!;
      const models = [...provider.modelStats.values()];

      expect(models.reduce((s, m) => s + m.input, 0)).toBe(provider.input);
      expect(models.reduce((s, m) => s + m.output, 0)).toBe(provider.output);
      expect(models.reduce((s, m) => s + m.cacheWrite, 0)).toBe(
        provider.cacheWrite
      );
      expect(models.reduce((s, m) => s + m.cacheRead, 0)).toBe(
        provider.cacheRead
      );
      expect(models.reduce((s, m) => s + m.reasoning, 0)).toBe(
        provider.reasoning
      );
      expect(models.reduce((s, m) => s + m.cost, 0)).toBeCloseTo(
        provider.cost,
        10
      );
    });

    test("session providerStats tokens sum to session totals", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const msg1 = createMessage(
        "claude-opus-4-5",
        "anthropic",
        timestamp,
        1000,
        500,
        "ses-1",
        100,
        200,
        50
      );
      const msg2 = createMessage(
        "gpt-4o",
        "openai",
        timestamp,
        2000,
        1000,
        "ses-1",
        150,
        300,
        80
      );

      const result = aggregateByDate([msg1, msg2]);
      const session = result.get("2025-12-15")!.sessionStats.get("ses-1")!;
      const providers = [...session.providerStats.values()];

      expect(providers.reduce((s, p) => s + p.input, 0)).toBe(session.input);
      expect(providers.reduce((s, p) => s + p.output, 0)).toBe(session.output);
      expect(providers.reduce((s, p) => s + p.cacheWrite, 0)).toBe(
        session.cacheWrite
      );
      expect(providers.reduce((s, p) => s + p.cacheRead, 0)).toBe(
        session.cacheRead
      );
      expect(providers.reduce((s, p) => s + p.reasoning, 0)).toBe(
        session.reasoning
      );
      expect(providers.reduce((s, p) => s + p.cost, 0)).toBeCloseTo(
        session.cost,
        10
      );
    });

    test("__unknown__ session accumulates providerStats from multiple messages", () => {
      const timestamp = new Date("2025-12-15").getTime();
      const msg1 = createMessageNoSession(
        "claude-opus-4-5",
        "anthropic",
        timestamp,
        1000,
        500
      );
      const msg2 = createMessageNoSession(
        "gpt-4o",
        "openai",
        timestamp,
        2000,
        1000
      );

      const result = aggregateByDate([msg1, msg2]);
      const unknown = result
        .get("2025-12-15")!
        .sessionStats.get("__unknown__")!;

      expect(unknown.providerStats.size).toBe(2);
      expect(unknown.providerStats.has("anthropic")).toBe(true);
      expect(unknown.providerStats.has("openai")).toBe(true);
    });
  });

  describe("filterByDays", () => {
    test("filters to last N days", () => {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const twoDaysAgo = new Date(today);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

      const todayStr = today.toISOString().split("T")[0];
      const yesterdayStr = yesterday.toISOString().split("T")[0];
      const twoDaysAgoStr = twoDaysAgo.toISOString().split("T")[0];

      const dailyStats = new Map<string, DailyStats>([
        [todayStr, createDailyStats(todayStr)],
        [yesterdayStr, createDailyStats(yesterdayStr)],
        [twoDaysAgoStr, createDailyStats(twoDaysAgoStr)],
      ]);

      const result = filterByDays(dailyStats, 0);

      expect(result.size).toBe(1);
      expect(result.has(todayStr)).toBe(true);
    });

    test("includes boundary date for 1 day filter", () => {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const todayStr = today.toISOString().split("T")[0];
      const yesterdayStr = yesterday.toISOString().split("T")[0];

      const dailyStats = new Map<string, DailyStats>([
        [todayStr, createDailyStats(todayStr)],
        [yesterdayStr, createDailyStats(yesterdayStr)],
      ]);

      const result = filterByDays(dailyStats, 1);

      expect(result.size).toBeGreaterThanOrEqual(1);
      expect(result.has(todayStr)).toBe(true);
    });
  });

  describe("filterByDateRange", () => {
    test("filters by since date", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-10", createDailyStats("2025-12-10")],
        ["2025-12-15", createDailyStats("2025-12-15")],
      ]);

      const result = filterByDateRange(dailyStats, "2025-12-12");

      expect(result.size).toBe(1);
      expect(result.has("2025-12-15")).toBe(true);
    });

    test("filters by until date", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-10", createDailyStats("2025-12-10")],
        ["2025-12-15", createDailyStats("2025-12-15")],
      ]);

      const result = filterByDateRange(dailyStats, undefined, "2025-12-12");

      expect(result.size).toBe(1);
      expect(result.has("2025-12-10")).toBe(true);
    });

    test("filters by both since and until", () => {
      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-10", createDailyStats("2025-12-10")],
        ["2025-12-15", createDailyStats("2025-12-15")],
        ["2025-12-20", createDailyStats("2025-12-20")],
      ]);

      const result = filterByDateRange(dailyStats, "2025-12-12", "2025-12-18");

      expect(result.size).toBe(1);
      expect(result.has("2025-12-15")).toBe(true);
    });
  });

  describe("aggregateByMonth", () => {
    test("groups daily stats by month", () => {
      const stats1 = createDailyStats(
        "2025-12-10",
        ["claude-opus-4-5"],
        ["anthropic"],
        1000,
        500,
        5
      );
      stats1.providerStats.set("anthropic", {
        input: 1000,
        output: 500,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 5,
        models: new Set(["claude-opus-4-5"]),
        modelStats: new Map(),
      });

      const stats2 = createDailyStats(
        "2025-12-15",
        ["claude-opus-4-5"],
        ["anthropic"],
        2000,
        1000,
        10
      );
      stats2.providerStats.set("anthropic", {
        input: 2000,
        output: 1000,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 10,
        models: new Set(["claude-opus-4-5"]),
        modelStats: new Map(),
      });

      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-10", stats1],
        ["2025-12-15", stats2],
      ]);

      const result = aggregateByMonth(dailyStats);

      expect(result.size).toBe(1);
      expect(result.has("2025-12")).toBe(true);

      const monthStats = result.get("2025-12")!;
      expect(monthStats.input).toBe(3000);
      expect(monthStats.output).toBe(1500);
      expect(monthStats.cost).toBe(15);
    });

    test("separates different months", () => {
      const stats1 = createDailyStats(
        "2025-11-30",
        ["claude-opus-4-5"],
        ["anthropic"],
        1000,
        500,
        5
      );
      stats1.providerStats.set("anthropic", {
        input: 1000,
        output: 500,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 5,
        models: new Set(["claude-opus-4-5"]),
        modelStats: new Map(),
      });

      const stats2 = createDailyStats(
        "2025-12-01",
        ["claude-opus-4-5"],
        ["anthropic"],
        2000,
        1000,
        10
      );
      stats2.providerStats.set("anthropic", {
        input: 2000,
        output: 1000,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 10,
        models: new Set(["claude-opus-4-5"]),
        modelStats: new Map(),
      });

      const dailyStats = new Map<string, DailyStats>([
        ["2025-11-30", stats1],
        ["2025-12-01", stats2],
      ]);

      const result = aggregateByMonth(dailyStats);

      expect(result.size).toBe(2);
      expect(result.has("2025-11")).toBe(true);
      expect(result.has("2025-12")).toBe(true);
    });

    test("merges provider stats across days", () => {
      const stats1 = createDailyStats(
        "2025-12-10",
        ["claude-opus-4-5"],
        ["anthropic"],
        1000,
        500,
        5
      );
      stats1.providerStats.set("anthropic", {
        input: 1000,
        output: 500,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 5,
        models: new Set(["claude-opus-4-5"]),
        modelStats: new Map(),
      });

      const stats2 = createDailyStats(
        "2025-12-15",
        ["gpt-4o"],
        ["openai"],
        2000,
        1000,
        10
      );
      stats2.providerStats.set("openai", {
        input: 2000,
        output: 1000,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 10,
        models: new Set(["gpt-4o"]),
        modelStats: new Map(),
      });

      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-10", stats1],
        ["2025-12-15", stats2],
      ]);

      const result = aggregateByMonth(dailyStats);

      const monthStats = result.get("2025-12")!;
      expect(monthStats.providerStats.size).toBe(2);
      expect(monthStats.providerStats.get("anthropic")!.input).toBe(1000);
      expect(monthStats.providerStats.get("openai")!.input).toBe(2000);
    });

    test("merges per-model stats across days", () => {
      const stats1 = createDailyStats(
        "2025-12-10",
        ["grok-4.5"],
        ["openrouter"],
        1000,
        500,
        5
      );
      stats1.providerStats.set("openrouter", {
        input: 1000,
        output: 500,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 5,
        models: new Set(["grok-4.5"]),
        modelStats: new Map([
          [
            "grok-4.5",
            {
              input: 1000,
              output: 500,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 5,
            },
          ],
        ]),
      });

      const stats2 = createDailyStats(
        "2025-12-15",
        ["grok-4.5"],
        ["openrouter"],
        2000,
        1000,
        10
      );
      stats2.providerStats.set("openrouter", {
        input: 2000,
        output: 1000,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 10,
        models: new Set(["grok-4.5"]),
        modelStats: new Map([
          [
            "grok-4.5",
            {
              input: 2000,
              output: 1000,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 10,
            },
          ],
        ]),
      });

      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-10", stats1],
        ["2025-12-15", stats2],
      ]);

      const result = aggregateByMonth(dailyStats);
      const provider = result.get("2025-12")!.providerStats.get("openrouter")!;

      expect(provider.modelStats.size).toBe(1);
      expect(provider.modelStats.get("grok-4.5")!.input).toBe(3000);
      expect(provider.modelStats.get("grok-4.5")!.output).toBe(1500);
      expect(provider.modelStats.get("grok-4.5")!.cost).toBe(15);
    });

    test("uses empty sessionStats map without merging sessions", () => {
      const stats1 = createDailyStats(
        "2025-12-10",
        ["claude-opus-4-5"],
        ["anthropic"],
        1000,
        500,
        5
      );
      // Simulate daily stats with populated sessionStats
      stats1.sessionStats.set("session-A", {
        sessionID: "session-A",
        input: 1000,
        output: 500,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 5,
        providerStats: new Map(),
      });

      const stats2 = createDailyStats(
        "2025-12-15",
        ["claude-opus-4-5"],
        ["anthropic"],
        2000,
        1000,
        10
      );
      stats2.sessionStats.set("session-B", {
        sessionID: "session-B",
        input: 2000,
        output: 1000,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 10,
        providerStats: new Map(),
      });

      const dailyStats = new Map<string, DailyStats>([
        ["2025-12-10", stats1],
        ["2025-12-15", stats2],
      ]);

      const result = aggregateByMonth(dailyStats);
      const monthStats = result.get("2025-12")!;

      // Monthly aggregation should NOT merge sessions — empty map
      expect(monthStats.sessionStats).toBeInstanceOf(Map);
      expect(monthStats.sessionStats.size).toBe(0);
    });
  });
});

describe("buildParentTrees", () => {
  test("root session with no parent becomes top-level node", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set("ses-1", createSessionStats("ses-1", 1000, 500, 0.5));

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("ses-1", createSessionInfo("ses-1", "Root session"));

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(1);
    expect(trees[0].sessionID).toBe("ses-1");
    expect(trees[0].classification).toBe("standalone");
    expect(trees[0].children).toHaveLength(0);
    expect(trees[0].ownStats.input).toBe(1000);
    expect(trees[0].totalStats.input).toBe(1000);
  });

  test("child session groups under parent", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set("parent-1", createSessionStats("parent-1", 500, 250, 0.3));
    sessionStats.set("child-1", createSessionStats("child-1", 1000, 500, 0.7));

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set(
      "parent-1",
      createSessionInfo("parent-1", "Parent", null, "orchestrator")
    );
    sessionInfo.set(
      "child-1",
      createSessionInfo("child-1", "Child", "parent-1", "fixer")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(1);
    expect(trees[0].sessionID).toBe("parent-1");
    expect(trees[0].classification).toBe("parent");
    expect(trees[0].children).toHaveLength(1);
    expect(trees[0].children[0].sessionID).toBe("child-1");
    expect(trees[0].children[0].classification).toBe("standalone");
    expect(trees[0].totalStats.input).toBe(1500); // 500 + 1000
    expect(trees[0].totalStats.cost).toBeCloseTo(1.0, 10); // 0.3 + 0.7
  });

  test("orphan session (parent not in sessionStats) becomes top-level", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set(
      "orphan-1",
      createSessionStats("orphan-1", 1000, 500, 0.5)
    );

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set(
      "orphan-1",
      createSessionInfo("orphan-1", "Orphan", "missing-parent", "fixer")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(1);
    expect(trees[0].sessionID).toBe("orphan-1");
    expect(trees[0].classification).toBe("orphan");
    expect(trees[0].children).toHaveLength(0);
  });

  test("__unknown__ session is always top-level", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set(
      "__unknown__",
      createSessionStats("__unknown__", 1000, 500, 0.5)
    );
    sessionStats.set("parent-1", createSessionStats("parent-1", 500, 250, 0.3));

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("__unknown__", createSessionInfo("__unknown__", "Unknown"));
    sessionInfo.set(
      "parent-1",
      createSessionInfo("parent-1", "Parent", "__unknown__")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);

    // __unknown__ should be a root, not grouped under parent-1
    const unknownTree = trees.find((t) => t.sessionID === "__unknown__");
    expect(unknownTree).toBeDefined();
    expect(unknownTree!.classification).toBe("unknown");
    expect(unknownTree!.children).toHaveLength(0);
  });

  test("self-referencing parentId treated as root", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set("ses-1", createSessionStats("ses-1", 1000, 500, 0.5));

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("ses-1", createSessionInfo("ses-1", "Self-ref", "ses-1"));

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(1);
    expect(trees[0].sessionID).toBe("ses-1");
    expect(trees[0].children).toHaveLength(0);
  });

  test("empty parentId string treated as root", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set("ses-1", createSessionStats("ses-1", 1000, 500, 0.5));

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("ses-1", createSessionInfo("ses-1", "Empty parent", ""));

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(1);
    expect(trees[0].sessionID).toBe("ses-1");
  });

  test("children sorted by totalStats.cost descending", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set("parent-1", createSessionStats("parent-1", 100, 50, 0.1));
    sessionStats.set(
      "cheap-child",
      createSessionStats("cheap-child", 100, 50, 0.1)
    );
    sessionStats.set(
      "expensive-child",
      createSessionStats("expensive-child", 1000, 500, 0.9)
    );

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("parent-1", createSessionInfo("parent-1", "Parent"));
    sessionInfo.set(
      "cheap-child",
      createSessionInfo("cheap-child", "Cheap", "parent-1")
    );
    sessionInfo.set(
      "expensive-child",
      createSessionInfo("expensive-child", "Expensive", "parent-1")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees[0].children[0].sessionID).toBe("expensive-child");
    expect(trees[0].children[1].sessionID).toBe("cheap-child");
  });

  test("root groups sorted by totalStats.cost descending", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set(
      "cheap-root",
      createSessionStats("cheap-root", 100, 50, 0.1)
    );
    sessionStats.set(
      "expensive-root",
      createSessionStats("expensive-root", 1000, 500, 0.9)
    );

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("cheap-root", createSessionInfo("cheap-root", "Cheap"));
    sessionInfo.set(
      "expensive-root",
      createSessionInfo("expensive-root", "Expensive")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees[0].sessionID).toBe("expensive-root");
    expect(trees[1].sessionID).toBe("cheap-root");
  });

  test("parent with no messages but children present: ownStats zeroed, totalStats = children sum", () => {
    const sessionStats = new Map<string, SessionStats>();
    // parent-1 has no entry in sessionStats
    sessionStats.set("child-1", createSessionStats("child-1", 1000, 500, 0.7));

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set(
      "parent-1",
      createSessionInfo("parent-1", "Parent", null, "orchestrator")
    );
    sessionInfo.set(
      "child-1",
      createSessionInfo("child-1", "Child", "parent-1", "fixer")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(1);
    expect(trees[0].sessionID).toBe("parent-1");
    expect(trees[0].classification).toBe("parent");
    expect(trees[0].ownStats.input).toBe(0);
    expect(trees[0].ownStats.cost).toBe(0);
    expect(trees[0].totalStats.input).toBe(1000);
    expect(trees[0].totalStats.cost).toBeCloseTo(0.7, 10);
  });

  test("multi-level hierarchy: grandchild rolls into child into grandparent", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set("gp", createSessionStats("gp", 100, 50, 0.1, "a", "m1"));
    sessionStats.set("p", createSessionStats("p", 200, 100, 0.2, "a", "m1"));
    sessionStats.set("c", createSessionStats("c", 300, 150, 0.3, "a", "m1"));

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("gp", createSessionInfo("gp", "Grandparent"));
    sessionInfo.set("p", createSessionInfo("p", "Parent", "gp"));
    sessionInfo.set("c", createSessionInfo("c", "Child", "p"));

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(1);
    expect(trees[0].sessionID).toBe("gp");
    expect(trees[0].children).toHaveLength(1);
    expect(trees[0].children[0].sessionID).toBe("p");
    expect(trees[0].children[0].children).toHaveLength(1);
    expect(trees[0].children[0].children[0].sessionID).toBe("c");
    expect(trees[0].totalStats.input).toBe(600); // 100 + 200 + 300
    expect(trees[0].totalStats.cost).toBeCloseTo(0.6, 10);
  });

  test("totalStats merges providerStats from own and children", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set(
      "parent-1",
      createSessionStats(
        "parent-1",
        500,
        250,
        0.3,
        "anthropic",
        "claude-opus-4-5"
      )
    );
    sessionStats.set(
      "child-1",
      createSessionStats("child-1", 1000, 500, 0.7, "openai", "gpt-4o")
    );

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("parent-1", createSessionInfo("parent-1", "Parent"));
    sessionInfo.set(
      "child-1",
      createSessionInfo("child-1", "Child", "parent-1")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees[0].totalStats.providerStats.size).toBe(2);
    expect(trees[0].totalStats.providerStats.has("anthropic")).toBe(true);
    expect(trees[0].totalStats.providerStats.has("openai")).toBe(true);
  });

  test("totalStats same-provider/same-model merges all metrics correctly", () => {
    const sessionStats = new Map<string, SessionStats>();
    // Parent uses anthropic/claude-opus-4-5 with specific cache/reasoning values
    const parentStats: SessionStats = {
      sessionID: "parent-1",
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 20,
      reasoning: 30,
      cost: 0.1,
      providerStats: new Map(),
    };
    const parentPs: ProviderStats = {
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 20,
      reasoning: 30,
      cost: 0.1,
      models: new Set(["claude-opus-4-5"]),
      modelStats: new Map(),
    };
    parentPs.modelStats.set("claude-opus-4-5", {
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 20,
      reasoning: 30,
      cost: 0.1,
    });
    parentStats.providerStats.set("anthropic", parentPs);
    sessionStats.set("parent-1", parentStats);

    // Child uses same provider/model with different values
    const childStats: SessionStats = {
      sessionID: "child-1",
      input: 200,
      output: 100,
      cacheWrite: 40,
      cacheRead: 80,
      reasoning: 60,
      cost: 0.2,
      providerStats: new Map(),
    };
    const childPs: ProviderStats = {
      input: 200,
      output: 100,
      cacheWrite: 40,
      cacheRead: 80,
      reasoning: 60,
      cost: 0.2,
      models: new Set(["claude-opus-4-5"]),
      modelStats: new Map(),
    };
    childPs.modelStats.set("claude-opus-4-5", {
      input: 200,
      output: 100,
      cacheWrite: 40,
      cacheRead: 80,
      reasoning: 60,
      cost: 0.2,
    });
    childStats.providerStats.set("anthropic", childPs);
    sessionStats.set("child-1", childStats);

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("parent-1", createSessionInfo("parent-1", "Parent"));
    sessionInfo.set(
      "child-1",
      createSessionInfo("child-1", "Child", "parent-1")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);
    const total = trees[0].totalStats;

    // All metrics summed
    expect(total.input).toBe(300);
    expect(total.output).toBe(150);
    expect(total.cacheWrite).toBe(50);
    expect(total.cacheRead).toBe(100);
    expect(total.reasoning).toBe(90);
    expect(total.cost).toBeCloseTo(0.3, 10);

    // Provider-level merge
    const prov = total.providerStats.get("anthropic")!;
    expect(prov.input).toBe(300);
    expect(prov.output).toBe(150);
    expect(prov.cacheWrite).toBe(50);
    expect(prov.cacheRead).toBe(100);
    expect(prov.reasoning).toBe(90);
    expect(prov.cost).toBeCloseTo(0.3, 10);
    expect(prov.models).toEqual(new Set(["claude-opus-4-5"]));

    // Model-level merge
    const model = prov.modelStats.get("claude-opus-4-5")!;
    expect(model.input).toBe(300);
    expect(model.output).toBe(150);
    expect(model.cacheWrite).toBe(50);
    expect(model.cacheRead).toBe(100);
    expect(model.reasoning).toBe(90);
    expect(model.cost).toBeCloseTo(0.3, 10);
  });

  test("source sessionStats maps are not mutated", () => {
    const sessionStats = new Map<string, SessionStats>();
    const parentStats = createSessionStats(
      "parent-1",
      100,
      50,
      0.1,
      "anthropic",
      "claude-opus-4-5"
    );
    const childStats = createSessionStats(
      "child-1",
      200,
      100,
      0.2,
      "anthropic",
      "claude-opus-4-5"
    );
    sessionStats.set("parent-1", parentStats);
    sessionStats.set("child-1", childStats);

    // Snapshot originals
    const origParentInput = parentStats.input;
    const origChildInput = childStats.input;
    const origParentProvInput =
      parentStats.providerStats.get("anthropic")!.input;
    const origParentModelInput = parentStats.providerStats
      .get("anthropic")!
      .modelStats.get("claude-opus-4-5")!.input;

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("parent-1", createSessionInfo("parent-1", "Parent"));
    sessionInfo.set(
      "child-1",
      createSessionInfo("child-1", "Child", "parent-1")
    );

    buildParentTrees(sessionStats, sessionInfo);

    // Verify originals not mutated
    expect(parentStats.input).toBe(origParentInput);
    expect(childStats.input).toBe(origChildInput);
    expect(parentStats.providerStats.get("anthropic")!.input).toBe(
      origParentProvInput
    );
    expect(
      parentStats.providerStats
        .get("anthropic")!
        .modelStats.get("claude-opus-4-5")!.input
    ).toBe(origParentModelInput);
  });

  test("cycle detection: both members are roots with no children, totals correct", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set("a", createSessionStats("a", 100, 50, 0.1));
    sessionStats.set("b", createSessionStats("b", 200, 100, 0.2));

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("a", createSessionInfo("a", "A", "b"));
    sessionInfo.set("b", createSessionInfo("b", "B", "a"));

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(2);

    const rootA = trees.find((t) => t.sessionID === "a")!;
    const rootB = trees.find((t) => t.sessionID === "b")!;

    expect(rootA).toBeDefined();
    expect(rootB).toBeDefined();

    // Cycle members are standalone (no children after cycle break)
    expect(rootA.classification).toBe("standalone");
    expect(rootB.classification).toBe("standalone");

    // No children — cycle broken
    expect(rootA.children).toHaveLength(0);
    expect(rootB.children).toHaveLength(0);

    // Each keeps its own stats as total (no child rollup)
    expect(rootA.ownStats.input).toBe(100);
    expect(rootA.totalStats.input).toBe(100);
    expect(rootA.totalStats.cost).toBeCloseTo(0.1, 10);

    expect(rootB.ownStats.input).toBe(200);
    expect(rootB.totalStats.input).toBe(200);
    expect(rootB.totalStats.cost).toBeCloseTo(0.2, 10);

    // Neither session appears as a child of the other
    expect(rootA.children.some((c) => c.sessionID === "b")).toBe(false);
    expect(rootB.children.some((c) => c.sessionID === "a")).toBe(false);
  });

  test("empty sessionStats returns empty trees", () => {
    const sessionStats = new Map<string, SessionStats>();
    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("ses-1", createSessionInfo("ses-1", "Session 1"));
    sessionInfo.set("ses-2", createSessionInfo("ses-2", "Session 2", "ses-1"));

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(0);
  });

  test("unrelated metadata-only sessions are excluded", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set(
      "active-1",
      createSessionStats("active-1", 1000, 500, 0.5)
    );

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set("active-1", createSessionInfo("active-1", "Active"));
    // These metadata-only sessions are not ancestors of active-1
    sessionInfo.set(
      "unrelated-1",
      createSessionInfo("unrelated-1", "Unrelated 1", "unrelated-2")
    );
    sessionInfo.set(
      "unrelated-2",
      createSessionInfo("unrelated-2", "Unrelated 2")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(1);
    expect(trees[0].sessionID).toBe("active-1");
    expect(trees[0].children).toHaveLength(0);

    // Collect all session IDs in the tree
    const allTreeIds = new Set<string>();
    function collect(node: ParentTreeNode) {
      allTreeIds.add(node.sessionID);
      for (const c of node.children) collect(c);
    }
    for (const t of trees) collect(t);

    expect(allTreeIds.has("unrelated-1")).toBe(false);
    expect(allTreeIds.has("unrelated-2")).toBe(false);
  });

  test("metadata-only parent with multiple active children groups them", () => {
    const sessionStats = new Map<string, SessionStats>();
    sessionStats.set("child-1", createSessionStats("child-1", 1000, 500, 0.7));
    sessionStats.set("child-2", createSessionStats("child-2", 2000, 1000, 1.3));

    const sessionInfo = new Map<string, SessionInfo>();
    sessionInfo.set(
      "parent-1",
      createSessionInfo("parent-1", "Parent", null, "orchestrator")
    );
    sessionInfo.set(
      "child-1",
      createSessionInfo("child-1", "Child 1", "parent-1", "fixer")
    );
    sessionInfo.set(
      "child-2",
      createSessionInfo("child-2", "Child 2", "parent-1", "fixer")
    );

    const trees = buildParentTrees(sessionStats, sessionInfo);

    expect(trees).toHaveLength(1);
    expect(trees[0].sessionID).toBe("parent-1");
    expect(trees[0].classification).toBe("parent");
    expect(trees[0].children).toHaveLength(2);
    expect(trees[0].ownStats.input).toBe(0);
    expect(trees[0].ownStats.cost).toBe(0);
    expect(trees[0].totalStats.input).toBe(3000);
    expect(trees[0].totalStats.cost).toBeCloseTo(2.0, 10);
  });
});
