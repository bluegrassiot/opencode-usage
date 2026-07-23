import { describe, test, expect } from "bun:test";
import {
  parseUsageRows,
  aggregateMonthly,
  computeVisibleRows,
  reduceExpansion,
  INITIAL_EXPANSION,
} from "../commander-ui/src/lib/data-utils.js";
import type {
  UsageRow,
  SessionDetail,
  ProviderDetail,
  ModelDetail,
  ExpansionState,
} from "../commander-ui/src/lib/data-utils.js";
import type { MessageJson } from "../types.js";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("parseUsageRows", () => {
  test("parses { days, sessions } with full ordered SessionDetail objects", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 3000,
          output: 1500,
          cacheWrite: 200,
          cacheRead: 100,
          reasoning: 50,
          cost: 0.5,
          models: ["claude-opus-4-5"],
          providers: ["anthropic"],
          providerStats: {},
          sessionStats: {
            "ses-1": {
              sessionID: "ses-1",
              input: 1000,
              output: 500,
              cacheWrite: 80,
              cacheRead: 40,
              reasoning: 20,
              cost: 0.2,
            },
            "ses-2": {
              sessionID: "ses-2",
              input: 2000,
              output: 1000,
              cacheWrite: 120,
              cacheRead: 60,
              reasoning: 30,
              cost: 0.3,
            },
          },
        },
      ],
      sessions: {
        "ses-1": { title: "Fix auth", slug: "fix-auth" },
        "ses-2": { title: "Refactor", slug: "refactor" },
      },
    };

    const rows = parseUsageRows(data);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionDetails).toHaveLength(2);
    // Sorted by cost descending: ses-2 (0.3) then ses-1 (0.2)
    expect(rows[0].sessionDetails[0]).toEqual({
      sessionID: "ses-2",
      title: "Refactor",
      input: 2000,
      output: 1000,
      cacheWrite: 120,
      cacheRead: 60,
      reasoning: 30,
      cost: 0.3,
      providerDetails: [],
    });
    expect(rows[0].sessionDetails[1]).toEqual({
      sessionID: "ses-1",
      title: "Fix auth",
      input: 1000,
      output: 500,
      cacheWrite: 80,
      cacheRead: 40,
      reasoning: 20,
      cost: 0.2,
      providerDetails: [],
    });
  });

  test("falls back to slug when title is empty", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 1000,
          output: 500,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {
            "ses-1": {
              sessionID: "ses-1",
              input: 1000,
              output: 500,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
            },
          },
        },
      ],
      sessions: {
        "ses-1": { title: "", slug: "fix-auth" },
      },
    };

    const rows = parseUsageRows(data);
    expect(rows[0].sessionDetails[0].title).toBe("fix-auth");
  });

  test("falls back to sessionID when title and slug are empty", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 1000,
          output: 500,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {
            "ses-1": {
              sessionID: "ses-1",
              input: 1000,
              output: 500,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
            },
          },
        },
      ],
      sessions: {
        "ses-1": { title: "", slug: "" },
      },
    };

    const rows = parseUsageRows(data);
    expect(rows[0].sessionDetails[0].title).toBe("ses-1");
  });

  test("handles missing sessions map gracefully", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 1000,
          output: 500,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {
            "ses-1": {
              sessionID: "ses-1",
              input: 1000,
              output: 500,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
            },
          },
        },
      ],
    };

    const rows = parseUsageRows(data);
    expect(rows[0].sessionDetails[0].title).toBe("ses-1");
  });

  test("legacy array and { days, sessions } produce identical full rows", () => {
    const dayRow = {
      date: "2025-12-15",
      input: 5000,
      output: 2500,
      cacheWrite: 300,
      cacheRead: 150,
      reasoning: 80,
      cost: 1.2,
      models: ["claude-opus-4-5", "claude-sonnet-4"],
      providers: ["anthropic"],
      providerStats: {
        anthropic: {
          input: 5000,
          output: 2500,
          cacheWrite: 300,
          cacheRead: 150,
          reasoning: 80,
          cost: 1.2,
          models: ["claude-opus-4-5", "claude-sonnet-4"],
          modelStats: {
            "claude-opus-4-5": {
              input: 3000,
              output: 1500,
              cacheWrite: 200,
              cacheRead: 100,
              reasoning: 50,
              cost: 0.8,
            },
            "claude-sonnet-4": {
              input: 2000,
              output: 1000,
              cacheWrite: 100,
              cacheRead: 50,
              reasoning: 30,
              cost: 0.4,
            },
          },
        },
      },
      sessionStats: {},
    };

    const legacy = parseUsageRows([dayRow]);
    const modern = parseUsageRows({ days: [dayRow], sessions: {} });

    expect(legacy).toHaveLength(1);
    expect(modern).toHaveLength(1);

    // Ordinary usage fields match
    expect(legacy[0].date).toBe(modern[0].date);
    expect(legacy[0].inputTokens).toBe(modern[0].inputTokens);
    expect(legacy[0].outputTokens).toBe(modern[0].outputTokens);
    expect(legacy[0].totalTokens).toBe(modern[0].totalTokens);
    expect(legacy[0].cost).toBe(modern[0].cost);
    expect(legacy[0].cacheWrite).toBe(modern[0].cacheWrite);
    expect(legacy[0].cacheRead).toBe(modern[0].cacheRead);
    expect(legacy[0].reasoning).toBe(modern[0].reasoning);

    // Models and providers
    expect(legacy[0].models).toEqual(modern[0].models);
    expect(legacy[0].providers).toEqual(modern[0].providers);

    // Provider details with nested model details
    expect(legacy[0].providerDetails).toEqual(modern[0].providerDetails);

    // Session details both empty (no sessionStats entries)
    expect(legacy[0].sessionDetails).toEqual([]);
    expect(modern[0].sessionDetails).toEqual([]);
  });
});

describe("aggregateMonthly", () => {
  test("single-row month produces empty sessionDetails", () => {
    const rows: ReturnType<typeof parseUsageRows> = [
      {
        date: "2025-12-15",
        models: ["m1"],
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cost: 0.3,
        providers: ["p1"],
        providerDetails: [],
        sessionDetails: [
          {
            sessionID: "ses-1",
            title: "Fix auth",
            input: 1000,
            output: 500,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.3,
            providerDetails: [],
          },
        ],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const monthly = aggregateMonthly(rows);
    expect(monthly).toHaveLength(1);
    expect(monthly[0].sessionDetails).toEqual([]);
  });

  test("merging multiple daily rows clears sessionDetails", () => {
    const rows: ReturnType<typeof parseUsageRows> = [
      {
        date: "2025-12-10",
        models: ["m1"],
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cost: 0.2,
        providers: ["p1"],
        providerDetails: [],
        sessionDetails: [
          {
            sessionID: "ses-A",
            title: "Session A",
            input: 1000,
            output: 500,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.2,
            providerDetails: [],
          },
        ],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
      {
        date: "2025-12-20",
        models: ["m1"],
        inputTokens: 2000,
        outputTokens: 1000,
        totalTokens: 3000,
        cost: 0.4,
        providers: ["p1"],
        providerDetails: [],
        sessionDetails: [
          {
            sessionID: "ses-B",
            title: "Session B",
            input: 2000,
            output: 1000,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.4,
            providerDetails: [],
          },
        ],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const monthly = aggregateMonthly(rows);
    expect(monthly).toHaveLength(1);
    // sessionDetails must be empty after merge
    expect(monthly[0].sessionDetails).toEqual([]);
    // Totals still accumulate correctly
    expect(monthly[0].inputTokens).toBe(3000);
    expect(monthly[0].outputTokens).toBe(1500);
    expect(monthly[0].cost).toBeCloseTo(0.6);
  });
});

// ============================================================================
// Zero-cost session: retained through aggregation → serialization → parsing
// ============================================================================

describe("zero-cost session round-trip", () => {
  test("zero-cost session is retained in parseUsageRows with correct metadata", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 500,
          output: 200,
          cacheWrite: 0,
          cacheRead: 0,
          reasoning: 0,
          cost: 0,
          models: ["qwen3-coder"],
          providers: ["opencode"],
          providerStats: {
            opencode: {
              input: 500,
              output: 200,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0,
              models: ["qwen3-coder"],
              modelStats: {
                "qwen3-coder": {
                  input: 500,
                  output: 200,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 0,
                },
              },
            },
          },
          sessionStats: {
            "ses-free": {
              sessionID: "ses-free",
              input: 500,
              output: 200,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0,
            },
          },
        },
      ],
      sessions: {
        "ses-free": { title: "Free model session", slug: "free-model" },
      },
    };

    const rows = parseUsageRows(data);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionDetails).toHaveLength(1);
    expect(rows[0].sessionDetails[0]).toEqual({
      sessionID: "ses-free",
      title: "Free model session",
      input: 500,
      output: 200,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 0,
      providerDetails: [],
    });
    expect(rows[0].cost).toBe(0);
  });

  test("zero-cost session appears alongside paid sessions, sorted by cost descending", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 2500,
          output: 1200,
          cacheWrite: 0,
          cacheRead: 0,
          reasoning: 0,
          cost: 0.35,
          models: ["claude-opus-4-5", "qwen3-coder"],
          providers: ["anthropic", "opencode"],
          providerStats: {},
          sessionStats: {
            "ses-paid": {
              sessionID: "ses-paid",
              input: 2000,
              output: 1000,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.35,
            },
            "ses-free": {
              sessionID: "ses-free",
              input: 500,
              output: 200,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0,
            },
          },
        },
      ],
      sessions: {
        "ses-paid": { title: "Paid session", slug: "paid" },
        "ses-free": { title: "Free session", slug: "free" },
      },
    };

    const rows = parseUsageRows(data);
    expect(rows[0].sessionDetails).toHaveLength(2);
    // Sorted by cost descending: paid first, free last
    expect(rows[0].sessionDetails[0].sessionID).toBe("ses-paid");
    expect(rows[0].sessionDetails[0].cost).toBe(0.35);
    expect(rows[0].sessionDetails[1].sessionID).toBe("ses-free");
    expect(rows[0].sessionDetails[1].cost).toBe(0);
  });
});

// ============================================================================
// getUsageData integration: real SQLite → production getUsageData → parseUsageRows
// ============================================================================

describe("getUsageData integration (SQLite-backed)", () => {
  // These tests create a temporary SQLite database, point the production
  // getUsageData at it via XDG_DATA_HOME, and verify that session metadata
  // and serialized session stats survive the full service path.

  function createIntegrationDb(dir: string): Database {
    const db = new Database(join(dir, "opencode.db"));
    db.run(`CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    )`);
    return db;
  }

  function insertAssistantMessage(
    db: Database,
    id: string,
    sessionId: string,
    modelID: string,
    providerID: string,
    input: number,
    output: number,
    timestamp: number
  ) {
    const data: Omit<MessageJson, "id" | "sessionID"> = {
      role: "assistant",
      model: { providerID, modelID },
      tokens: {
        input,
        output,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: timestamp, completed: timestamp },
    };
    db.run(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
      [id, sessionId, timestamp, timestamp, JSON.stringify(data)]
    );
  }

  test("getUsageData returns { days, sessions } with correct session metadata and stats", async () => {
    const testDir = join(tmpdir(), `opencode-integ-${Date.now()}`);
    const opencodeDir = join(testDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });

    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = testDir;

    try {
      const db = createIntegrationDb(opencodeDir);
      db.run(
        `INSERT INTO session VALUES ('ses-1', 'proj-1', 'fix-auth', '/tmp', 'Fix auth', '1.0', 0, 0)`
      );
      db.run(
        `INSERT INTO session VALUES ('ses-2', 'proj-1', 'refactor', '/tmp', 'Refactor', '1.0', 0, 0)`
      );

      const timestamp = new Date("2025-12-15T12:00:00Z").getTime();
      insertAssistantMessage(
        db,
        "msg-1",
        "ses-1",
        "claude-opus-4-5",
        "anthropic",
        1000,
        500,
        timestamp
      );
      insertAssistantMessage(
        db,
        "msg-2",
        "ses-2",
        "gpt-4o",
        "openai",
        2000,
        1000,
        timestamp
      );
      db.close();

      const { getUsageData } =
        await import("../commander/services/usage-service.js");
      const response = await getUsageData();

      // Verify response shape
      expect(response.days).toBeDefined();
      expect(response.sessions).toBeDefined();
      expect(Array.isArray(response.days)).toBe(true);

      // Verify session metadata is present
      expect(response.sessions["ses-1"]).toEqual({
        title: "Fix auth",
        slug: "fix-auth",
        parentId: null,
        agent: null,
      });
      expect(response.sessions["ses-2"]).toEqual({
        title: "Refactor",
        slug: "refactor",
        parentId: null,
        agent: null,
      });

      // Verify serialized session stats exist in the day
      const day = response.days.find((d) => d.date === "2025-12-15")!;
      expect(day).toBeDefined();
      expect(day.sessionStats["ses-1"]).toBeDefined();
      expect(day.sessionStats["ses-2"]).toBeDefined();
      expect(day.sessionStats["ses-1"].input).toBe(1000);
      expect(day.sessionStats["ses-1"].output).toBe(500);
      expect(day.sessionStats["ses-2"].input).toBe(2000);
      expect(day.sessionStats["ses-2"].output).toBe(1000);

      // Pass to parseUsageRows and verify metadata round-trips
      const rows = parseUsageRows(response);
      expect(rows).toHaveLength(1);
      expect(rows[0].sessionDetails).toHaveLength(2);

      const ses1 = rows[0].sessionDetails.find((s) => s.sessionID === "ses-1")!;
      const ses2 = rows[0].sessionDetails.find((s) => s.sessionID === "ses-2")!;
      expect(ses1.title).toBe("Fix auth");
      expect(ses1.input).toBe(1000);
      expect(ses1.output).toBe(500);
      expect(ses2.title).toBe("Refactor");
      expect(ses2.input).toBe(2000);
      expect(ses2.output).toBe(1000);

      // Verify provider stats also survive
      expect(rows[0].providerDetails).toHaveLength(2);
      const anthropicPd = rows[0].providerDetails.find(
        (p) => p.provider === "anthropic"
      )!;
      const openaiPd = rows[0].providerDetails.find(
        (p) => p.provider === "openai"
      )!;
      expect(anthropicPd.input).toBe(1000);
      expect(openaiPd.input).toBe(2000);
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = savedXdg;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("getUsageData with zero-cost (free) model retains session in response and parseUsageRows", async () => {
    const testDir = join(tmpdir(), `opencode-integ-free-${Date.now()}`);
    const opencodeDir = join(testDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });

    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = testDir;

    try {
      const db = createIntegrationDb(opencodeDir);
      db.run(
        `INSERT INTO session VALUES ('ses-free', 'proj-1', 'free-session', '/tmp', 'Free session', '1.0', 0, 0)`
      );

      const timestamp = new Date("2025-12-15T12:00:00Z").getTime();
      insertAssistantMessage(
        db,
        "msg-free",
        "ses-free",
        "qwen3-coder",
        "opencode",
        500,
        200,
        timestamp
      );
      db.close();

      const { getUsageData } =
        await import("../commander/services/usage-service.js");
      const response = await getUsageData();

      // Session metadata survives
      expect(response.sessions["ses-free"]).toEqual({
        title: "Free session",
        slug: "free-session",
        parentId: null,
        agent: null,
      });

      const day = response.days.find((d) => d.date === "2025-12-15")!;
      expect(day).toBeDefined();
      expect(day.sessionStats["ses-free"]).toBeDefined();
      expect(day.sessionStats["ses-free"].input).toBe(500);
      expect(day.sessionStats["ses-free"].output).toBe(200);
      expect(day.sessionStats["ses-free"].cost).toBe(0);

      // Round-trip through parseUsageRows
      const rows = parseUsageRows(response);
      expect(rows).toHaveLength(1);
      expect(rows[0].sessionDetails).toHaveLength(1);
      expect(rows[0].sessionDetails[0].sessionID).toBe("ses-free");
      expect(rows[0].sessionDetails[0].title).toBe("Free session");
      expect(rows[0].sessionDetails[0].cost).toBe(0);
      expect(rows[0].cost).toBe(0);
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = savedXdg;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("getUsageData with days filter still preserves session stats", async () => {
    const testDir = join(tmpdir(), `opencode-integ-filter-${Date.now()}`);
    const opencodeDir = join(testDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });

    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = testDir;

    try {
      const db = createIntegrationDb(opencodeDir);
      db.run(
        `INSERT INTO session VALUES ('ses-1', 'proj-1', 'recent', '/tmp', 'Recent session', '1.0', 0, 0)`
      );

      const now = Date.now();
      insertAssistantMessage(
        db,
        "msg-recent",
        "ses-1",
        "claude-opus-4-5",
        "anthropic",
        800,
        400,
        now
      );
      db.close();

      const { getUsageData } =
        await import("../commander/services/usage-service.js");
      const response = await getUsageData({ days: 1 });

      // Response has session metadata
      expect(response.sessions["ses-1"]).toEqual({
        title: "Recent session",
        slug: "recent",
        parentId: null,
        agent: null,
      });

      // At least one day with session stats
      const dayWithSession = response.days.find((d) => d.sessionStats["ses-1"]);
      expect(dayWithSession).toBeDefined();
      expect(dayWithSession!.sessionStats["ses-1"].input).toBe(800);

      // parseUsageRows preserves it
      const rows = parseUsageRows(response);
      const rowWithSession = rows.find((r) =>
        r.sessionDetails.some((s) => s.sessionID === "ses-1")
      );
      expect(rowWithSession).toBeDefined();
      expect(
        rowWithSession!.sessionDetails.find((s) => s.sessionID === "ses-1")!
          .title
      ).toBe("Recent session");
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = savedXdg;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("getUsageData returns session providerStats with nested modelStats in serialized response", async () => {
    const testDir = join(tmpdir(), `opencode-integ-sesprov-${Date.now()}`);
    const opencodeDir = join(testDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });

    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = testDir;

    try {
      const db = createIntegrationDb(opencodeDir);
      db.run(
        `INSERT INTO session VALUES ('ses-1', 'proj-1', 'fix-auth', '/tmp', 'Fix auth', '1.0', 0, 0)`
      );

      const timestamp = new Date("2025-12-15T12:00:00Z").getTime();
      // Two messages in same session, different providers
      insertAssistantMessage(
        db,
        "msg-1",
        "ses-1",
        "claude-opus-4-5",
        "anthropic",
        1000,
        500,
        timestamp
      );
      insertAssistantMessage(
        db,
        "msg-2",
        "ses-1",
        "gpt-4o",
        "openai",
        2000,
        1000,
        timestamp
      );
      db.close();

      const { getUsageData } =
        await import("../commander/services/usage-service.js");
      const response = await getUsageData();

      const day = response.days.find((d) => d.date === "2025-12-15")!;
      expect(day).toBeDefined();

      // Session stats have providerStats
      const sesStats = day.sessionStats["ses-1"];
      expect(sesStats).toBeDefined();
      expect(sesStats.providerStats).toBeDefined();
      expect(sesStats.providerStats["anthropic"]).toBeDefined();
      expect(sesStats.providerStats["openai"]).toBeDefined();

      // Provider stats within session have correct values
      expect(sesStats.providerStats["anthropic"].input).toBe(1000);
      expect(sesStats.providerStats["anthropic"].output).toBe(500);
      expect(sesStats.providerStats["openai"].input).toBe(2000);
      expect(sesStats.providerStats["openai"].output).toBe(1000);

      // Provider stats within session have modelStats
      expect(
        sesStats.providerStats["anthropic"].modelStats["claude-opus-4-5"]
      ).toBeDefined();
      expect(
        sesStats.providerStats["anthropic"].modelStats["claude-opus-4-5"].input
      ).toBe(1000);

      // Round-trip through parseUsageRows
      const rows = parseUsageRows(response);
      const ses = rows[0].sessionDetails.find((s) => s.sessionID === "ses-1")!;
      expect(ses.providerDetails).toBeDefined();
      expect(ses.providerDetails.length).toBe(2);

      // Verify provider details round-trip with correct values
      const anthropicSesPd = ses.providerDetails.find(
        (p) => p.provider === "anthropic"
      )!;
      const openaiSesPd = ses.providerDetails.find(
        (p) => p.provider === "openai"
      )!;
      expect(anthropicSesPd.input).toBe(1000);
      expect(anthropicSesPd.output).toBe(500);
      expect(openaiSesPd.input).toBe(2000);
      expect(openaiSesPd.output).toBe(1000);

      // Verify model details round-trip within session providers
      expect(anthropicSesPd.modelDetails).toHaveLength(1);
      expect(anthropicSesPd.modelDetails[0].model).toBe("claude-opus-4-5");
      expect(anthropicSesPd.modelDetails[0].input).toBe(1000);
      expect(openaiSesPd.modelDetails).toHaveLength(1);
      expect(openaiSesPd.modelDetails[0].model).toBe("gpt-4o");
      expect(openaiSesPd.modelDetails[0].input).toBe(2000);
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = savedXdg;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("getUsageData returns parentGroups in serialized response", async () => {
    const testDir = join(tmpdir(), `opencode-integ-parent-${Date.now()}`);
    const opencodeDir = join(testDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });

    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = testDir;

    try {
      const db = createIntegrationDb(opencodeDir);
      // Add parent_id and agent columns to session table
      db.run(`ALTER TABLE session ADD COLUMN parent_id TEXT`);
      db.run(`ALTER TABLE session ADD COLUMN agent TEXT`);
      db.run(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, parent_id, agent) VALUES ('parent-1', 'proj-1', 'parent', '/tmp', 'Parent session', '1.0', 0, 0, NULL, 'orchestrator')`
      );
      db.run(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, parent_id, agent) VALUES ('child-1', 'proj-1', 'child', '/tmp', 'Child session', '1.0', 0, 0, 'parent-1', 'fixer')`
      );

      const timestamp = new Date("2025-12-15T12:00:00Z").getTime();
      insertAssistantMessage(
        db,
        "msg-1",
        "parent-1",
        "claude-opus-4-5",
        "anthropic",
        500,
        250,
        timestamp
      );
      insertAssistantMessage(
        db,
        "msg-2",
        "child-1",
        "claude-opus-4-5",
        "anthropic",
        1000,
        500,
        timestamp
      );
      db.close();

      const { getUsageData } =
        await import("../commander/services/usage-service.js");
      const response = await getUsageData();

      const day = response.days.find((d) => d.date === "2025-12-15")!;
      expect(day).toBeDefined();
      expect(day.parentGroups).toBeDefined();
      expect(day.parentGroups).toHaveLength(1);
      expect(day.parentGroups[0].sessionID).toBe("parent-1");
      expect(day.parentGroups[0].classification).toBe("parent");
      expect(day.parentGroups[0].children).toHaveLength(1);
      expect(day.parentGroups[0].children[0].sessionID).toBe("child-1");
      expect(day.parentGroups[0].children[0].classification).toBe("standalone");
      expect(day.parentGroups[0].totalStats.input).toBe(1500);

      // ownStats preserved on parent (has own messages)
      expect(day.parentGroups[0].ownStats.input).toBe(500);
      expect(day.parentGroups[0].ownStats.cost).toBeGreaterThan(0);
      // ownStats preserved on child
      expect(day.parentGroups[0].children[0].ownStats.input).toBe(1000);
      expect(day.parentGroups[0].children[0].ownStats.cost).toBeGreaterThan(0);

      // Sessions metadata includes parentId and agent
      expect(response.sessions["parent-1"].parentId).toBeNull();
      expect(response.sessions["parent-1"].agent).toBe("orchestrator");
      expect(response.sessions["child-1"].parentId).toBe("parent-1");
      expect(response.sessions["child-1"].agent).toBe("fixer");
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = savedXdg;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("getUsageData with monthly=true returns empty parentGroups and sessionStats", async () => {
    const testDir = join(tmpdir(), `opencode-integ-monthly-${Date.now()}`);
    const opencodeDir = join(testDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });

    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = testDir;

    try {
      const db = createIntegrationDb(opencodeDir);
      db.run(`ALTER TABLE session ADD COLUMN parent_id TEXT`);
      db.run(`ALTER TABLE session ADD COLUMN agent TEXT`);
      db.run(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, parent_id, agent) VALUES ('parent-1', 'proj-1', 'parent', '/tmp', 'Parent', '1.0', 0, 0, NULL, 'orchestrator')`
      );
      db.run(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, parent_id, agent) VALUES ('child-1', 'proj-1', 'child', '/tmp', 'Child', '1.0', 0, 0, 'parent-1', 'fixer')`
      );

      const timestamp = new Date("2025-12-15T12:00:00Z").getTime();
      insertAssistantMessage(
        db,
        "msg-1",
        "parent-1",
        "claude-opus-4-5",
        "anthropic",
        500,
        250,
        timestamp
      );
      insertAssistantMessage(
        db,
        "msg-2",
        "child-1",
        "claude-opus-4-5",
        "anthropic",
        1000,
        500,
        timestamp
      );
      db.close();

      const { getUsageData } =
        await import("../commander/services/usage-service.js");
      const response = await getUsageData({ monthly: true });

      // Monthly view has a single aggregated row
      expect(response.days).toHaveLength(1);
      const month = response.days[0];

      // parentGroups is empty for monthly view
      expect(month.parentGroups).toEqual([]);

      // sessionStats is empty after aggregateByMonth merges days
      expect(Object.keys(month.sessionStats)).toHaveLength(0);

      // Totals still accumulate correctly
      expect(month.input).toBe(1500);
      expect(month.output).toBe(750);
      expect(month.cost).toBeGreaterThan(0);

      // Session metadata still present (not affected by monthly flag)
      expect(response.sessions["parent-1"].parentId).toBeNull();
      expect(response.sessions["child-1"].parentId).toBe("parent-1");
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = savedXdg;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("getUsageData parent group nested provider/model serialization is JSON-safe and structured", async () => {
    const testDir = join(tmpdir(), `opencode-integ-nested-${Date.now()}`);
    const opencodeDir = join(testDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });

    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = testDir;

    try {
      const db = createIntegrationDb(opencodeDir);
      db.run(`ALTER TABLE session ADD COLUMN parent_id TEXT`);
      db.run(`ALTER TABLE session ADD COLUMN agent TEXT`);
      db.run(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, parent_id, agent) VALUES ('parent-1', 'proj-1', 'parent', '/tmp', 'Parent', '1.0', 0, 0, NULL, 'orchestrator')`
      );
      db.run(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, parent_id, agent) VALUES ('child-1', 'proj-1', 'child', '/tmp', 'Child', '1.0', 0, 0, 'parent-1', 'fixer')`
      );

      const ts = new Date("2025-12-15T12:00:00Z").getTime();
      // Parent session: anthropic provider
      insertAssistantMessage(
        db,
        "msg-p1",
        "parent-1",
        "claude-opus-4-5",
        "anthropic",
        300,
        150,
        ts
      );
      // Child session: two different providers
      insertAssistantMessage(
        db,
        "msg-c1",
        "child-1",
        "claude-opus-4-5",
        "anthropic",
        500,
        250,
        ts
      );
      insertAssistantMessage(
        db,
        "msg-c2",
        "child-1",
        "gpt-4o",
        "openai",
        400,
        200,
        ts
      );
      db.close();

      const { getUsageData } =
        await import("../commander/services/usage-service.js");
      const response = await getUsageData();

      // JSON round-trip: verify the response is JSON-safe
      const jsonRoundTrip = JSON.parse(JSON.stringify(response));
      const rtDay = jsonRoundTrip.days.find(
        (d: { date: string }) => d.date === "2025-12-15"
      );
      expect(rtDay).toBeDefined();
      expect(rtDay.parentGroups).toHaveLength(1);

      const rtPg = rtDay.parentGroups[0];
      expect(rtPg.sessionID).toBe("parent-1");
      expect(rtPg.agent).toBe("orchestrator");

      // ownStats has anthropic provider with claude-opus-4-5 model
      expect(rtPg.ownStats.providerStats).toBeDefined();
      expect(rtPg.ownStats.providerStats.anthropic).toBeDefined();
      expect(rtPg.ownStats.providerStats.anthropic.input).toBe(300);
      expect(rtPg.ownStats.providerStats.anthropic.models).toEqual([
        "claude-opus-4-5",
      ]);
      expect(
        rtPg.ownStats.providerStats.anthropic.modelStats["claude-opus-4-5"]
      ).toBeDefined();
      expect(
        rtPg.ownStats.providerStats.anthropic.modelStats["claude-opus-4-5"]
          .input
      ).toBe(300);

      // Child has two providers after JSON round-trip
      expect(rtPg.children).toHaveLength(1);
      const rtChild = rtPg.children[0];
      expect(rtChild.sessionID).toBe("child-1");
      expect(rtChild.agent).toBe("fixer");
      expect(rtChild.ownStats.providerStats.anthropic).toBeDefined();
      expect(rtChild.ownStats.providerStats.anthropic.input).toBe(500);
      expect(rtChild.ownStats.providerStats.openai).toBeDefined();
      expect(rtChild.ownStats.providerStats.openai.input).toBe(400);
      expect(
        rtChild.ownStats.providerStats.openai.modelStats["gpt-4o"].input
      ).toBe(400);

      // totalStats rolls up parent + child
      expect(rtPg.totalStats.input).toBe(1200); // 300 + 500 + 400
      expect(rtPg.totalStats.providerStats.anthropic).toBeDefined();
      expect(rtPg.totalStats.providerStats.anthropic.input).toBe(800); // 300 + 500
      expect(rtPg.totalStats.providerStats.openai).toBeDefined();
      expect(rtPg.totalStats.providerStats.openai.input).toBe(400);

      // Verify Map-based objects serialized to plain records (not Maps)
      expect(rtPg.ownStats.providerStats).not.toHaveProperty("size");
      expect(rtPg.totalStats.providerStats).not.toHaveProperty("size");
      expect(rtChild.ownStats.providerStats).not.toHaveProperty("size");
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = savedXdg;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe("aggregateMonthly model cost re-sort", () => {
  test("multi-day merge re-sorts modelDetails when accumulated costs reverse order", () => {
    // Day 1: m1 cost 0.05, m2 cost 0.15 → m2 first
    // Day 2: m1 cost 0.30, m2 cost 0.02 → after merge: m1=0.35, m2=0.17 → m1 first
    const rows: UsageRow[] = [
      {
        date: "2025-12-10",
        models: ["m1", "m2"],
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.2,
        providers: ["p1"],
        providerDetails: [
          {
            provider: "p1",
            input: 100,
            output: 50,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.2,
            models: ["m1", "m2"],
            modelDetails: [
              {
                model: "m1",
                input: 40,
                output: 20,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.05,
              },
              {
                model: "m2",
                input: 60,
                output: 30,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.15,
              },
            ],
          },
        ],
        sessionDetails: [],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
      {
        date: "2025-12-20",
        models: ["m1", "m2"],
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 0.32,
        providers: ["p1"],
        providerDetails: [
          {
            provider: "p1",
            input: 200,
            output: 100,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.32,
            models: ["m1", "m2"],
            modelDetails: [
              {
                model: "m1",
                input: 180,
                output: 90,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.3,
              },
              {
                model: "m2",
                input: 20,
                output: 10,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.02,
              },
            ],
          },
        ],
        sessionDetails: [],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const monthly = aggregateMonthly(rows);
    expect(monthly).toHaveLength(1);

    const p1 = monthly[0].providerDetails.find((p) => p.provider === "p1")!;
    // After merge: m1 = 0.05 + 0.30 = 0.35, m2 = 0.15 + 0.02 = 0.17
    // m1 must come first by cost descending
    expect(p1.modelDetails[0].model).toBe("m1");
    expect(p1.modelDetails[0].cost).toBeCloseTo(0.35);
    expect(p1.modelDetails[1].model).toBe("m2");
    expect(p1.modelDetails[1].cost).toBeCloseTo(0.17);

    // Monthly summary behavior preserved
    expect(monthly[0].sessionDetails).toEqual([]);
    expect(monthly[0].cost).toBeCloseTo(0.52);
  });

  test("cross-day merge re-sorts providerDetails when accumulated costs reverse order", () => {
    // Day 1: cheap-p cost 0.40, expensive-p cost 0.10 → cheap-p first
    // Day 2: cheap-p cost 0.05, expensive-p cost 0.50 → after merge: cheap=0.45, expensive=0.60
    const rows: UsageRow[] = [
      {
        date: "2025-12-10",
        models: [],
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.5,
        providers: ["cheap-p", "expensive-p"],
        providerDetails: [
          {
            provider: "cheap-p",
            input: 80,
            output: 40,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.4,
            models: [],
            modelDetails: [],
          },
          {
            provider: "expensive-p",
            input: 20,
            output: 10,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.1,
            models: [],
            modelDetails: [],
          },
        ],
        sessionDetails: [],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
      {
        date: "2025-12-20",
        models: [],
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 0.55,
        providers: ["cheap-p", "expensive-p"],
        providerDetails: [
          {
            provider: "cheap-p",
            input: 40,
            output: 20,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.05,
            models: [],
            modelDetails: [],
          },
          {
            provider: "expensive-p",
            input: 160,
            output: 80,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.5,
            models: [],
            modelDetails: [],
          },
        ],
        sessionDetails: [],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const monthly = aggregateMonthly(rows);
    expect(monthly).toHaveLength(1);

    const providers = monthly[0].providerDetails;
    // After merge: expensive-p = 0.10 + 0.50 = 0.60, cheap-p = 0.40 + 0.05 = 0.45
    // expensive-p must now come first
    expect(providers[0].provider).toBe("expensive-p");
    expect(providers[0].cost).toBeCloseTo(0.6);
    expect(providers[1].provider).toBe("cheap-p");
    expect(providers[1].cost).toBeCloseTo(0.45);

    // Session clearing preserved
    expect(monthly[0].sessionDetails).toEqual([]);
  });
});

// ============================================================================
// parseParentGroups: recursive parent group API data parsing
// ============================================================================

describe("parseParentGroups", () => {
  test("parses parent groups from response", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 1500,
          output: 750,
          cost: 1.0,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "parent-1",
              title: "Parent session",
              agent: "orchestrator",
              ownStats: {
                sessionID: "parent-1",
                input: 500,
                output: 250,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.3,
                providerStats: {},
              },
              children: [
                {
                  sessionID: "child-1",
                  title: "Child session",
                  agent: "fixer",
                  ownStats: {
                    sessionID: "child-1",
                    input: 1000,
                    output: 500,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.7,
                    providerStats: {},
                  },
                  children: [],
                  totalStats: {
                    sessionID: "child-1",
                    input: 1000,
                    output: 500,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.7,
                    providerStats: {},
                  },
                },
              ],
              totalStats: {
                sessionID: "parent-1",
                input: 1500,
                output: 750,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 1.0,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {
        "parent-1": {
          title: "Parent session",
          slug: "parent",
          parentId: null,
          agent: "orchestrator",
        },
        "child-1": {
          title: "Child session",
          slug: "child",
          parentId: "parent-1",
          agent: "fixer",
        },
      },
    };

    const rows = parseUsageRows(data);
    expect(rows[0].parentGroups).toHaveLength(1);
    const pg = rows[0].parentGroups[0];
    expect(pg.sessionID).toBe("parent-1");
    expect(pg.title).toBe("Parent session (@orchestrator)");
    expect(pg.totalInput).toBe(1500);
    expect(pg.totalCost).toBeCloseTo(1.0, 10);
    expect(pg.children).toHaveLength(1);
    expect(pg.children[0].title).toBe("Child session (@fixer)");
  });

  test("agent suffix omitted when agent is null", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 100,
          output: 50,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "s1",
              title: "No agent",
              agent: null,
              ownStats: {
                sessionID: "s1",
                input: 100,
                output: 50,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.1,
                providerStats: {},
              },
              children: [],
              totalStats: {
                sessionID: "s1",
                input: 100,
                output: 50,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.1,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {
        s1: { title: "No agent", slug: "no-agent" },
      },
    };

    const rows = parseUsageRows(data);
    expect(rows[0].parentGroups[0].title).toBe("No agent");
  });

  test("agent suffix omitted when agent is empty string", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 100,
          output: 50,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "s1",
              title: "Empty agent",
              agent: "",
              ownStats: {
                sessionID: "s1",
                input: 100,
                output: 50,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.1,
                providerStats: {},
              },
              children: [],
              totalStats: {
                sessionID: "s1",
                input: 100,
                output: 50,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.1,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {
        s1: { title: "Empty agent", slug: "empty-agent" },
      },
    };

    const rows = parseUsageRows(data);
    expect(rows[0].parentGroups[0].title).toBe("Empty agent");
  });

  test("totalProviderDetails parsed from totalStats.providerStats", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 100,
          output: 50,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "s1",
              title: "Test",
              agent: null,
              ownStats: {
                sessionID: "s1",
                input: 0,
                output: 0,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0,
                providerStats: {},
              },
              children: [],
              totalStats: {
                sessionID: "s1",
                input: 100,
                output: 50,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.1,
                providerStats: {
                  anthropic: {
                    input: 100,
                    output: 50,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.1,
                    models: ["claude-opus-4-5"],
                    modelStats: {
                      "claude-opus-4-5": {
                        input: 100,
                        output: 50,
                        cacheWrite: 0,
                        cacheRead: 0,
                        reasoning: 0,
                        cost: 0.1,
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
      sessions: {},
    };

    const rows = parseUsageRows(data);
    expect(rows[0].parentGroups[0].totalProviderDetails).toHaveLength(1);
    expect(rows[0].parentGroups[0].totalProviderDetails[0].provider).toBe(
      "anthropic"
    );
  });

  test("missing parentGroups defaults to empty array", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 100,
          output: 50,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
        },
      ],
      sessions: {},
    };

    const rows = parseUsageRows(data);
    expect(rows[0].parentGroups).toEqual([]);
  });

  test("null parentGroups defaults to empty array", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 100,
          output: 50,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: null,
        },
      ],
      sessions: {},
    };

    const rows = parseUsageRows(data);
    expect(rows[0].parentGroups).toEqual([]);
  });

  test("reconciliation: day total = sum of parentGroup totals", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 3000,
          output: 1500,
          cost: 2.0,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "p1",
              title: "P1",
              agent: null,
              ownStats: {
                sessionID: "p1",
                input: 500,
                output: 250,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.5,
                providerStats: {},
              },
              children: [],
              totalStats: {
                sessionID: "p1",
                input: 500,
                output: 250,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.5,
                providerStats: {},
              },
            },
            {
              sessionID: "p2",
              title: "P2",
              agent: null,
              ownStats: {
                sessionID: "p2",
                input: 1000,
                output: 500,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 1.0,
                providerStats: {},
              },
              children: [
                {
                  sessionID: "c1",
                  title: "C1",
                  agent: null,
                  ownStats: {
                    sessionID: "c1",
                    input: 1500,
                    output: 750,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.5,
                    providerStats: {},
                  },
                  children: [],
                  totalStats: {
                    sessionID: "c1",
                    input: 1500,
                    output: 750,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.5,
                    providerStats: {},
                  },
                },
              ],
              totalStats: {
                sessionID: "p2",
                input: 2500,
                output: 1250,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 1.5,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {},
    };

    const rows = parseUsageRows(data);
    const pgCost = rows[0].parentGroups.reduce((s, pg) => s + pg.totalCost, 0);
    expect(pgCost).toBeCloseTo(2.0, 10);
  });

  test("monthly aggregation clears parentGroups", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.1,
        providers: [],
        providerDetails: [],
        sessionDetails: [],
        parentGroups: [
          {
            sessionID: "p1",
            title: "Parent",
            agent: null,
            classification: "parent",
            ownDetails: {
              sessionID: "p1",
              title: "Parent",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
              providerDetails: [],
            },
            children: [],
            totalInput: 100,
            totalOutput: 50,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 0.1,
            totalProviderDetails: [],
          },
        ],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const monthly = aggregateMonthly(rows);
    expect(monthly[0].parentGroups).toEqual([]);
  });

  test("children sorted by details.cost descending", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 3000,
          output: 1500,
          cost: 1.0,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "p1",
              title: "Parent",
              agent: null,
              ownStats: {
                sessionID: "p1",
                input: 0,
                output: 0,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0,
                providerStats: {},
              },
              children: [
                {
                  sessionID: "cheap",
                  title: "Cheap child",
                  agent: null,
                  ownStats: {
                    sessionID: "cheap",
                    input: 1000,
                    output: 500,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.2,
                    providerStats: {},
                  },
                  children: [],
                  totalStats: {
                    sessionID: "cheap",
                    input: 1000,
                    output: 500,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.2,
                    providerStats: {},
                  },
                },
                {
                  sessionID: "expensive",
                  title: "Expensive child",
                  agent: "fixer",
                  ownStats: {
                    sessionID: "expensive",
                    input: 2000,
                    output: 1000,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.8,
                    providerStats: {},
                  },
                  children: [],
                  totalStats: {
                    sessionID: "expensive",
                    input: 2000,
                    output: 1000,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.8,
                    providerStats: {},
                  },
                },
              ],
              totalStats: {
                sessionID: "p1",
                input: 3000,
                output: 1500,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 1.0,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {
        p1: { title: "Parent", slug: "parent" },
        cheap: { title: "Cheap child", slug: "cheap-child" },
        expensive: { title: "Expensive child", slug: "expensive-child" },
      },
    };

    const rows = parseUsageRows(data);
    const pg = rows[0].parentGroups[0];
    expect(pg.children).toHaveLength(2);
    // Expensive child (0.8) should come first
    expect(pg.children[0].sessionID).toBe("expensive");
    expect(pg.children[0].title).toBe("Expensive child (@fixer)");
    expect(pg.children[1].sessionID).toBe("cheap");
    expect(pg.children[1].title).toBe("Cheap child");
  });

  test("parentGroups sorted by totalCost descending", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 3000,
          output: 1500,
          cost: 1.0,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "cheap",
              title: "Cheap",
              agent: null,
              ownStats: {
                sessionID: "cheap",
                input: 1000,
                output: 500,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.2,
                providerStats: {},
              },
              children: [],
              totalStats: {
                sessionID: "cheap",
                input: 1000,
                output: 500,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.2,
                providerStats: {},
              },
            },
            {
              sessionID: "expensive",
              title: "Expensive",
              agent: null,
              ownStats: {
                sessionID: "expensive",
                input: 2000,
                output: 1000,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.8,
                providerStats: {},
              },
              children: [],
              totalStats: {
                sessionID: "expensive",
                input: 2000,
                output: 1000,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.8,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {},
    };

    const rows = parseUsageRows(data);
    expect(rows[0].parentGroups[0].sessionID).toBe("expensive");
    expect(rows[0].parentGroups[1].sessionID).toBe("cheap");
  });

  test("defensive: non-record parent group entries are filtered out", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 100,
          output: 50,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            null,
            42,
            "string",
            {
              sessionID: "valid",
              title: "Valid",
              agent: null,
              ownStats: {},
              children: [],
              totalStats: {},
            },
          ],
        },
      ],
      sessions: {},
    };

    const rows = parseUsageRows(data);
    expect(rows[0].parentGroups).toHaveLength(1);
    expect(rows[0].parentGroups[0].sessionID).toBe("valid");
  });

  test("defensive: non-record child entries are filtered out", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 100,
          output: 50,
          cost: 0.1,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "p1",
              title: "Parent",
              agent: null,
              ownStats: {},
              children: [
                null,
                42,
                { sessionID: "c1", title: "C1", agent: null, totalStats: {} },
              ],
              totalStats: {},
            },
          ],
        },
      ],
      sessions: {},
    };

    const rows = parseUsageRows(data);
    expect(rows[0].parentGroups[0].children).toHaveLength(1);
    expect(rows[0].parentGroups[0].children[0].sessionID).toBe("c1");
  });

  test("3-level hierarchy: grandchild nested under child", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 6000,
          output: 3000,
          cost: 3.0,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "grandparent",
              title: "Grandparent",
              agent: "orchestrator",
              ownStats: {
                sessionID: "grandparent",
                input: 1000,
                output: 500,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.5,
                providerStats: {},
              },
              children: [
                {
                  sessionID: "parent",
                  title: "Parent",
                  agent: "coordinator",
                  ownStats: {
                    sessionID: "parent",
                    input: 2000,
                    output: 1000,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 1.0,
                    providerStats: {},
                  },
                  children: [
                    {
                      sessionID: "grandchild",
                      title: "Grandchild",
                      agent: "fixer",
                      ownStats: {
                        sessionID: "grandchild",
                        input: 3000,
                        output: 1500,
                        cacheWrite: 0,
                        cacheRead: 0,
                        reasoning: 0,
                        cost: 1.5,
                        providerStats: {},
                      },
                      children: [],
                      totalStats: {
                        sessionID: "grandchild",
                        input: 3000,
                        output: 1500,
                        cacheWrite: 0,
                        cacheRead: 0,
                        reasoning: 0,
                        cost: 1.5,
                        providerStats: {},
                      },
                    },
                  ],
                  totalStats: {
                    sessionID: "parent",
                    input: 5000,
                    output: 2500,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 2.5,
                    providerStats: {},
                  },
                },
              ],
              totalStats: {
                sessionID: "grandparent",
                input: 6000,
                output: 3000,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 3.0,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {
        grandparent: { title: "Grandparent", slug: "grandparent" },
        parent: { title: "Parent", slug: "parent" },
        grandchild: { title: "Grandchild", slug: "grandchild" },
      },
    };

    const rows = parseUsageRows(data);
    const pg = rows[0].parentGroups[0];
    expect(pg.sessionID).toBe("grandparent");
    expect(pg.title).toBe("Grandparent (@orchestrator)");
    expect(pg.children).toHaveLength(1);

    const parentNode = pg.children[0];
    expect(parentNode.sessionID).toBe("parent");
    expect(parentNode.title).toBe("Parent (@coordinator)");
    expect(parentNode.children).toHaveLength(1);

    const grandchild = parentNode.children[0];
    expect(grandchild.sessionID).toBe("grandchild");
    expect(grandchild.title).toBe("Grandchild (@fixer)");
    expect(grandchild.children).toHaveLength(0);
    expect(grandchild.details.cost).toBeCloseTo(1.5);
  });

  test("empty title falls back to slug then sessionID", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 200,
          output: 100,
          cost: 0.2,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {
            "ses-slug": {
              sessionID: "ses-slug",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
            },
            "ses-id": {
              sessionID: "ses-id",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
            },
          },
          parentGroups: [
            {
              sessionID: "ses-slug",
              title: "",
              agent: null,
              ownStats: {
                sessionID: "ses-slug",
                input: 100,
                output: 50,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.1,
                providerStats: {},
              },
              children: [],
              totalStats: {
                sessionID: "ses-slug",
                input: 100,
                output: 50,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.1,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {
        "ses-slug": { title: "", slug: "my-session" },
        "ses-id": { title: "", slug: "" },
      },
    };

    const rows = parseUsageRows(data);
    // Parent group: empty title → falls back to slug "my-session"
    expect(rows[0].parentGroups[0].title).toBe("my-session");
    // Session ses-slug: empty title → falls back to slug "my-session"
    expect(
      rows[0].sessionDetails.find((s) => s.sessionID === "ses-slug")!.title
    ).toBe("my-session");
    // Session ses-id: empty title, empty slug → falls back to sessionID "ses-id"
    expect(
      rows[0].sessionDetails.find((s) => s.sessionID === "ses-id")!.title
    ).toBe("ses-id");
  });

  test("raw API node titles retained when sessions metadata absent", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 300,
          output: 150,
          cost: 0.3,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "pg-1",
              title: "My Parent Title",
              agent: "orchestrator",
              ownStats: {
                sessionID: "pg-1",
                input: 100,
                output: 50,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.1,
                providerStats: {},
              },
              children: [
                {
                  sessionID: "ch-1",
                  title: "My Child Title",
                  agent: "fixer",
                  ownStats: {},
                  children: [],
                  totalStats: {
                    sessionID: "ch-1",
                    input: 200,
                    output: 100,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.2,
                    providerStats: {},
                  },
                },
              ],
              totalStats: {
                sessionID: "pg-1",
                input: 300,
                output: 150,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.3,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {},
    };

    const rows = parseUsageRows(data);
    // Raw API titles used directly even with empty sessions metadata
    expect(rows[0].parentGroups[0].title).toBe(
      "My Parent Title (@orchestrator)"
    );
    expect(rows[0].parentGroups[0].children[0].title).toBe(
      "My Child Title (@fixer)"
    );
  });

  test("whitespace-only agent is treated as null", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 150,
          output: 75,
          cost: 0.15,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {},
          parentGroups: [
            {
              sessionID: "p1",
              title: "Parent",
              agent: "   ",
              ownStats: {
                sessionID: "p1",
                input: 100,
                output: 50,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.1,
                providerStats: {},
              },
              children: [
                {
                  sessionID: "c1",
                  title: "Child",
                  agent: "  fixer  ",
                  ownStats: {},
                  children: [],
                  totalStats: {
                    sessionID: "c1",
                    input: 50,
                    output: 25,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.05,
                    providerStats: {},
                  },
                },
              ],
              totalStats: {
                sessionID: "p1",
                input: 150,
                output: 75,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.15,
                providerStats: {},
              },
            },
          ],
        },
      ],
      sessions: {
        p1: { title: "Parent", slug: "parent" },
        c1: { title: "Child", slug: "child" },
      },
    };

    const rows = parseUsageRows(data);
    // Whitespace-only agent → null, no @agent suffix
    expect(rows[0].parentGroups[0].title).toBe("Parent");
    expect(rows[0].parentGroups[0].agent).toBeNull();
    // Padded agent → trimmed to "fixer"
    expect(rows[0].parentGroups[0].children[0].title).toBe("Child (@fixer)");
    expect(rows[0].parentGroups[0].children[0].agent).toBe("fixer");
  });

  test("empty/whitespace sessionID entries are filtered out", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          input: 300,
          output: 150,
          cost: 0.3,
          models: [],
          providers: [],
          providerStats: {},
          sessionStats: {
            "": {
              sessionID: "",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
            },
            "  ": {
              sessionID: "  ",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
            },
            valid: {
              sessionID: "valid",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
            },
          },
          parentGroups: [
            {
              sessionID: "",
              title: "Empty ID",
              agent: null,
              ownStats: {},
              children: [],
              totalStats: {},
            },
            {
              sessionID: "   ",
              title: "Whitespace ID",
              agent: null,
              ownStats: {},
              children: [],
              totalStats: {},
            },
            {
              sessionID: "valid-pg",
              title: "Valid",
              agent: null,
              ownStats: {},
              children: [
                {
                  sessionID: "",
                  title: "Empty child ID",
                  agent: null,
                  ownStats: {},
                  children: [],
                  totalStats: {},
                },
                {
                  sessionID: "  ",
                  title: "Whitespace child ID",
                  agent: null,
                  ownStats: {},
                  children: [],
                  totalStats: {},
                },
                {
                  sessionID: "valid-child",
                  title: "Valid child",
                  agent: null,
                  ownStats: {},
                  children: [],
                  totalStats: {},
                },
              ],
              totalStats: {},
            },
          ],
        },
      ],
      sessions: {
        valid: { title: "Valid session", slug: "valid" },
        "valid-pg": { title: "Valid parent", slug: "valid-pg" },
        "valid-child": { title: "Valid child", slug: "valid-child" },
      },
    };

    const rows = parseUsageRows(data);
    // Empty/whitespace sessionID entries filtered from sessionDetails
    expect(rows[0].sessionDetails).toHaveLength(1);
    expect(rows[0].sessionDetails[0].sessionID).toBe("valid");
    // Empty/whitespace sessionID parent groups filtered
    expect(rows[0].parentGroups).toHaveLength(1);
    expect(rows[0].parentGroups[0].sessionID).toBe("valid-pg");
    // Empty/whitespace sessionID children filtered
    expect(rows[0].parentGroups[0].children).toHaveLength(1);
    expect(rows[0].parentGroups[0].children[0].sessionID).toBe("valid-child");
  });

  test("multi-day monthly merge clears parentGroups from both days", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-10",
        models: [],
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.1,
        providers: [],
        providerDetails: [],
        sessionDetails: [],
        parentGroups: [
          {
            sessionID: "p1",
            title: "Parent 1",
            agent: null,
            classification: "parent",
            ownDetails: {
              sessionID: "p1",
              title: "Parent 1",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.1,
              providerDetails: [],
            },
            children: [],
            totalInput: 100,
            totalOutput: 50,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 0.1,
            totalProviderDetails: [],
          },
        ],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
      {
        date: "2025-12-20",
        models: [],
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 0.2,
        providers: [],
        providerDetails: [],
        sessionDetails: [],
        parentGroups: [
          {
            sessionID: "p2",
            title: "Parent 2",
            agent: null,
            classification: "parent",
            ownDetails: {
              sessionID: "p2",
              title: "Parent 2",
              input: 200,
              output: 100,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.2,
              providerDetails: [],
            },
            children: [],
            totalInput: 200,
            totalOutput: 100,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 0.2,
            totalProviderDetails: [],
          },
        ],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const monthly = aggregateMonthly(rows);
    expect(monthly).toHaveLength(1);
    // Both days' parentGroups cleared after merge
    expect(monthly[0].parentGroups).toEqual([]);
    // Totals still accumulate correctly
    expect(monthly[0].inputTokens).toBe(300);
    expect(monthly[0].outputTokens).toBe(150);
    expect(monthly[0].cost).toBeCloseTo(0.3);
  });
});

// ============================================================================
// Shared fixture for nested session/provider/model tests
// ============================================================================

function createMultiSessionMultiProviderFixture() {
  return {
    days: [
      {
        date: "2025-12-15",
        input: 5000,
        output: 2500,
        cacheWrite: 200,
        cacheRead: 100,
        reasoning: 50,
        cost: 1.0,
        models: ["claude-opus-4-5", "gpt-4o"],
        providers: ["anthropic", "openai"],
        providerStats: {
          anthropic: {
            input: 3000,
            output: 1500,
            cacheWrite: 120,
            cacheRead: 60,
            reasoning: 30,
            cost: 0.6,
            models: ["claude-opus-4-5"],
            modelStats: {
              "claude-opus-4-5": {
                input: 3000,
                output: 1500,
                cacheWrite: 120,
                cacheRead: 60,
                reasoning: 30,
                cost: 0.6,
              },
            },
          },
          openai: {
            input: 2000,
            output: 1000,
            cacheWrite: 80,
            cacheRead: 40,
            reasoning: 20,
            cost: 0.4,
            models: ["gpt-4o"],
            modelStats: {
              "gpt-4o": {
                input: 2000,
                output: 1000,
                cacheWrite: 80,
                cacheRead: 40,
                reasoning: 20,
                cost: 0.4,
              },
            },
          },
        },
        sessionStats: {
          "ses-1": {
            sessionID: "ses-1",
            input: 3000,
            output: 1500,
            cacheWrite: 120,
            cacheRead: 60,
            reasoning: 30,
            cost: 0.6,
            providerStats: {
              anthropic: {
                input: 3000,
                output: 1500,
                cacheWrite: 120,
                cacheRead: 60,
                reasoning: 30,
                cost: 0.6,
                models: ["claude-opus-4-5"],
                modelStats: {
                  "claude-opus-4-5": {
                    input: 3000,
                    output: 1500,
                    cacheWrite: 120,
                    cacheRead: 60,
                    reasoning: 30,
                    cost: 0.6,
                  },
                },
              },
            },
          },
          "ses-2": {
            sessionID: "ses-2",
            input: 2000,
            output: 1000,
            cacheWrite: 80,
            cacheRead: 40,
            reasoning: 20,
            cost: 0.4,
            providerStats: {
              openai: {
                input: 2000,
                output: 1000,
                cacheWrite: 80,
                cacheRead: 40,
                reasoning: 20,
                cost: 0.4,
                models: ["gpt-4o"],
                modelStats: {
                  "gpt-4o": {
                    input: 2000,
                    output: 1000,
                    cacheWrite: 80,
                    cacheRead: 40,
                    reasoning: 20,
                    cost: 0.4,
                  },
                },
              },
            },
          },
        },
      },
    ],
    sessions: {
      "ses-1": { title: "Session A", slug: "session-a" },
      "ses-2": { title: "Session B", slug: "session-b" },
    },
  };
}

// ============================================================================
// Nested session provider/model mapping: parser correctly maps multi-level
// providerStats through session → provider → model, preserving structure.
// (Full reconciliation of totals is covered by the SQLite integration tests
// above; this focuses on the parser's nested mapping behavior.)
// ============================================================================

describe("nested session provider mapping", () => {
  test("multi-session multi-provider multi-model maps correctly through parseUsageRows", () => {
    const data = createMultiSessionMultiProviderFixture();

    const rows = parseUsageRows(data);
    const day = rows[0];

    // Sessions parsed with correct provider nesting
    expect(day.sessionDetails).toHaveLength(2);
    const ses1 = day.sessionDetails.find((s) => s.sessionID === "ses-1")!;
    const ses2 = day.sessionDetails.find((s) => s.sessionID === "ses-2")!;

    // ses-1 → anthropic → claude-opus-4-5
    expect(ses1.input).toBe(3000);
    expect(ses1.output).toBe(1500);
    expect(ses1.cacheWrite).toBe(120);
    expect(ses1.cacheRead).toBe(60);
    expect(ses1.reasoning).toBe(30);
    expect(ses1.cost).toBe(0.6);

    const aProv = ses1.providerDetails[0];
    expect(aProv.provider).toBe("anthropic");
    expect(aProv.input).toBe(3000);
    expect(aProv.output).toBe(1500);
    expect(aProv.cacheWrite).toBe(120);
    expect(aProv.cacheRead).toBe(60);
    expect(aProv.reasoning).toBe(30);
    expect(aProv.cost).toBe(0.6);

    const aModel = aProv.modelDetails[0];
    expect(aModel.model).toBe("claude-opus-4-5");
    expect(aModel.input).toBe(3000);
    expect(aModel.output).toBe(1500);
    expect(aModel.cacheWrite).toBe(120);
    expect(aModel.cacheRead).toBe(60);
    expect(aModel.reasoning).toBe(30);
    expect(aModel.cost).toBe(0.6);

    // ses-2 → openai → gpt-4o
    expect(ses2.input).toBe(2000);
    expect(ses2.output).toBe(1000);
    expect(ses2.cacheWrite).toBe(80);
    expect(ses2.cacheRead).toBe(40);
    expect(ses2.reasoning).toBe(20);
    expect(ses2.cost).toBe(0.4);

    const oProv = ses2.providerDetails[0];
    expect(oProv.provider).toBe("openai");
    expect(oProv.input).toBe(2000);
    expect(oProv.output).toBe(1000);
    expect(oProv.cacheWrite).toBe(80);
    expect(oProv.cacheRead).toBe(40);
    expect(oProv.reasoning).toBe(20);
    expect(oProv.cost).toBe(0.4);

    const oModel = oProv.modelDetails[0];
    expect(oModel.model).toBe("gpt-4o");
    expect(oModel.input).toBe(2000);
    expect(oModel.output).toBe(1000);
    expect(oModel.cacheWrite).toBe(80);
    expect(oModel.cacheRead).toBe(40);
    expect(oModel.reasoning).toBe(20);
    expect(oModel.cost).toBe(0.4);

    // Day-level provider details also parsed (independent of sessions)
    expect(day.providerDetails).toHaveLength(2);
  });

  test("session providerDetails sorted by cost desc across multiple providers", () => {
    const data = [
      {
        date: "2025-12-15",
        input: 100,
        output: 100,
        cost: 1.0,
        models: [],
        providers: [],
        providerStats: {},
        sessionStats: {
          ses: {
            sessionID: "ses",
            input: 100,
            output: 100,
            cost: 1.0,
            providerStats: {
              cheap: {
                input: 80,
                output: 80,
                cost: 0.1,
                models: ["m"],
                modelStats: {},
              },
              expensive: {
                input: 20,
                output: 20,
                cost: 0.9,
                models: ["m"],
                modelStats: {},
              },
            },
          },
        },
      },
    ];

    const rows = parseUsageRows(data);
    const providers = rows[0].sessionDetails[0].providerDetails;
    expect(providers[0].provider).toBe("expensive");
    expect(providers[1].provider).toBe("cheap");
  });

  test("session modelDetails sorted by cost desc within a provider", () => {
    const data = [
      {
        date: "2025-12-15",
        input: 100,
        output: 100,
        cost: 1.0,
        models: [],
        providers: [],
        providerStats: {},
        sessionStats: {
          ses: {
            sessionID: "ses",
            input: 100,
            output: 100,
            cost: 1.0,
            providerStats: {
              p: {
                input: 100,
                output: 100,
                cost: 1.0,
                models: ["m1", "m2"],
                modelStats: {
                  m1: {
                    input: 80,
                    output: 80,
                    cost: 0.1,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                  },
                  m2: {
                    input: 20,
                    output: 20,
                    cost: 0.9,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                  },
                },
              },
            },
          },
        },
      },
    ];

    const rows = parseUsageRows(data);
    const models = rows[0].sessionDetails[0].providerDetails[0].modelDetails;
    expect(models[0].model).toBe("m2");
    expect(models[1].model).toBe("m1");
  });

  test("handles missing/null session providerStats defensively", () => {
    const missingData = [
      {
        date: "2025-12-15",
        input: 100,
        output: 50,
        cost: 0.1,
        models: [],
        providers: [],
        providerStats: {},
        sessionStats: {
          ses: { sessionID: "ses", input: 100, output: 50, cost: 0.1 },
        },
      },
    ];
    const nullData = [
      {
        date: "2025-12-15",
        input: 100,
        output: 50,
        cost: 0.1,
        models: [],
        providers: [],
        providerStats: {},
        sessionStats: {
          ses: {
            sessionID: "ses",
            input: 100,
            output: 50,
            cost: 0.1,
            providerStats: null,
          },
        },
      },
    ];

    expect(
      parseUsageRows(missingData)[0].sessionDetails[0].providerDetails
    ).toEqual([]);
    expect(
      parseUsageRows(nullData)[0].sessionDetails[0].providerDetails
    ).toEqual([]);
  });

  test("__unknown__ session displays 'Unknown session' and parses providerStats", () => {
    const data = [
      {
        date: "2025-12-15",
        input: 100,
        output: 50,
        cost: 0.1,
        models: [],
        providers: [],
        providerStats: {},
        sessionStats: {
          __unknown__: {
            sessionID: "__unknown__",
            input: 100,
            output: 50,
            cost: 0.1,
            providerStats: {
              anthropic: {
                input: 100,
                output: 50,
                cost: 0.1,
                models: ["m1"],
                modelStats: {
                  m1: {
                    input: 100,
                    output: 50,
                    cost: 0.1,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                  },
                },
              },
            },
          },
        },
      },
    ];

    const ses = parseUsageRows(data)[0].sessionDetails[0];
    expect(ses.title).toBe("Unknown session");
    expect(ses.providerDetails).toHaveLength(1);
    expect(ses.providerDetails[0].provider).toBe("anthropic");
    expect(ses.providerDetails[0].modelDetails).toHaveLength(1);
    expect(ses.providerDetails[0].modelDetails[0].model).toBe("m1");
  });
});

// ============================================================================
// Nested sum preservation: all-level valid-data sums match parent totals
// after parseUsageRows (parser preserves nesting structure, not aggregation)
// ============================================================================

describe("nested sum preservation", () => {
  test("session/provider/model sums preserve nesting through parseUsageRows", () => {
    const data = createMultiSessionMultiProviderFixture();

    const rows = parseUsageRows(data);
    const day = rows[0];

    // Session totals reconcile with day totals
    const sesSum = (fn: (s: SessionDetail) => number) =>
      day.sessionDetails.reduce((s, sd) => s + fn(sd), 0);

    expect(sesSum((s) => s.input)).toBe(day.inputTokens);
    expect(sesSum((s) => s.output)).toBe(day.outputTokens);
    expect(sesSum((s) => s.cacheWrite)).toBe(day.cacheWrite);
    expect(sesSum((s) => s.cacheRead)).toBe(day.cacheRead);
    expect(sesSum((s) => s.reasoning)).toBe(day.reasoning);
    expect(sesSum((s) => s.cost)).toBeCloseTo(day.cost, 10);

    // Provider totals within each session reconcile with session totals
    for (const ses of day.sessionDetails) {
      const provSum = (fn: (p: ProviderDetail) => number) =>
        ses.providerDetails.reduce((s, p) => s + fn(p), 0);

      expect(provSum((p) => p.input)).toBe(ses.input);
      expect(provSum((p) => p.output)).toBe(ses.output);
      expect(provSum((p) => p.cacheWrite)).toBe(ses.cacheWrite);
      expect(provSum((p) => p.cacheRead)).toBe(ses.cacheRead);
      expect(provSum((p) => p.reasoning)).toBe(ses.reasoning);
      expect(provSum((p) => p.cost)).toBeCloseTo(ses.cost, 10);

      // Model totals within each provider reconcile with provider totals
      for (const prov of ses.providerDetails) {
        const modSum = (fn: (m: ModelDetail) => number) =>
          prov.modelDetails.reduce((s, m) => s + fn(m), 0);

        expect(modSum((m) => m.input)).toBe(prov.input);
        expect(modSum((m) => m.output)).toBe(prov.output);
        expect(modSum((m) => m.cacheWrite)).toBe(prov.cacheWrite);
        expect(modSum((m) => m.cacheRead)).toBe(prov.cacheRead);
        expect(modSum((m) => m.reasoning)).toBe(prov.reasoning);
        expect(modSum((m) => m.cost)).toBeCloseTo(prov.cost, 10);
      }
    }
  });
});

// ============================================================================
// computeVisibleRows: deterministic UI order testing
// ============================================================================

function createVisibleRowsFixture(): UsageRow[] {
  return [
    {
      date: "2025-12-15",
      models: ["claude-opus-4-5", "gpt-4o"],
      inputTokens: 5000,
      outputTokens: 2500,
      totalTokens: 7500,
      cost: 1.0,
      providers: ["anthropic", "openai"],
      providerDetails: [
        {
          provider: "anthropic",
          input: 3000,
          output: 1500,
          cacheWrite: 120,
          cacheRead: 60,
          reasoning: 30,
          cost: 0.6,
          models: ["claude-opus-4-5"],
          modelDetails: [
            {
              model: "claude-opus-4-5",
              input: 3000,
              output: 1500,
              cacheWrite: 120,
              cacheRead: 60,
              reasoning: 30,
              cost: 0.6,
            },
          ],
        },
        {
          provider: "openai",
          input: 2000,
          output: 1000,
          cacheWrite: 80,
          cacheRead: 40,
          reasoning: 20,
          cost: 0.4,
          models: ["gpt-4o"],
          modelDetails: [
            {
              model: "gpt-4o",
              input: 2000,
              output: 1000,
              cacheWrite: 80,
              cacheRead: 40,
              reasoning: 20,
              cost: 0.4,
            },
          ],
        },
      ],
      sessionDetails: [
        {
          sessionID: "ses-1",
          title: "Fix auth",
          input: 3000,
          output: 1500,
          cacheWrite: 120,
          cacheRead: 60,
          reasoning: 30,
          cost: 0.6,
          providerDetails: [
            {
              provider: "anthropic",
              input: 3000,
              output: 1500,
              cacheWrite: 120,
              cacheRead: 60,
              reasoning: 30,
              cost: 0.6,
              models: ["claude-opus-4-5"],
              modelDetails: [
                {
                  model: "claude-opus-4-5",
                  input: 3000,
                  output: 1500,
                  cacheWrite: 120,
                  cacheRead: 60,
                  reasoning: 30,
                  cost: 0.6,
                },
              ],
            },
          ],
        },
        {
          sessionID: "ses-2",
          title: "Refactor",
          input: 2000,
          output: 1000,
          cacheWrite: 80,
          cacheRead: 40,
          reasoning: 20,
          cost: 0.4,
          providerDetails: [
            {
              provider: "openai",
              input: 2000,
              output: 1000,
              cacheWrite: 80,
              cacheRead: 40,
              reasoning: 20,
              cost: 0.4,
              models: ["gpt-4o"],
              modelDetails: [
                {
                  model: "gpt-4o",
                  input: 2000,
                  output: 1000,
                  cacheWrite: 80,
                  cacheRead: 40,
                  reasoning: 20,
                  cost: 0.4,
                },
              ],
            },
          ],
        },
      ],
      parentGroups: [],
      cacheWrite: 200,
      cacheRead: 100,
      reasoning: 50,
    },
  ];
}

describe("computeVisibleRows", () => {
  test("returns only day rows when nothing expanded", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(),
      parentGroups: new Set(),
      sessions: new Set(),
      providers: new Set(),
    });
    expect(visible).toHaveLength(1);
    expect(visible[0].kind).toBe("day");
    expect(visible[0].label).toBe("2025-12-15");
    expect(visible[0].level).toBe(0);
  });

  test("expanding day shows sessions in cost-desc order", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(),
      providers: new Set(),
    });
    expect(visible).toHaveLength(3);
    expect(visible.map((r) => r.kind)).toEqual(["day", "session", "session"]);
    // Sessions sorted by cost desc: Fix auth (0.6) then Refactor (0.4)
    expect(visible[1].label).toBe("Fix auth");
    expect(visible[1].level).toBe(1);
    expect(visible[2].label).toBe("Refactor");
    expect(visible[2].level).toBe(1);
  });

  test("expanding session shows providers in cost-desc order", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1"]),
      providers: new Set(),
    });
    // day + ses-1 + ses-2 + provider under ses-1
    expect(visible).toHaveLength(4);
    expect(visible.map((r) => r.kind)).toEqual([
      "day",
      "session",
      "provider",
      "session",
    ]);
    expect(visible[2].kind).toBe("provider");
    expect(visible[2].label).toBe("anthropic");
    expect(visible[2].level).toBe(2);
  });

  test("expanding provider shows models in cost-desc order", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1"]),
      providers: new Set(["2025-12-15:ses-1:anthropic"]),
    });
    // day + ses-1 + provider + model + ses-2
    expect(visible).toHaveLength(5);
    expect(visible.map((r) => r.kind)).toEqual([
      "day",
      "session",
      "provider",
      "model",
      "session",
    ]);
    expect(visible[3].kind).toBe("model");
    expect(visible[3].label).toBe("claude-opus-4-5");
    expect(visible[3].level).toBe(3);
  });

  test("full expansion produces day→session→provider→model hierarchy", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1", "2025-12-15:ses-2"]),
      providers: new Set([
        "2025-12-15:ses-1:anthropic",
        "2025-12-15:ses-2:openai",
      ]),
    });
    // 1 day + 2 sessions + 2 providers + 2 models = 7
    expect(visible).toHaveLength(7);
    expect(visible.map((r) => r.kind)).toEqual([
      "day",
      "session",
      "provider",
      "model",
      "session",
      "provider",
      "model",
    ]);
    // Verify ordering: sessions by cost desc, providers within session by cost desc
    expect(visible[1].label).toBe("Fix auth"); // 0.6
    expect(visible[4].label).toBe("Refactor"); // 0.4
  });

  test("all visible rows have all 7 metric fields as numbers", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1"]),
      providers: new Set(["2025-12-15:ses-1:anthropic"]),
    });
    for (const row of visible) {
      expect(typeof row.input).toBe("number");
      expect(typeof row.output).toBe("number");
      expect(typeof row.cacheWrite).toBe("number");
      expect(typeof row.cacheRead).toBe("number");
      expect(typeof row.reasoning).toBe("number");
      expect(typeof row.cost).toBe("number");
    }
    // Spot-check specific values at each level
    const day = visible.find((r) => r.kind === "day")!;
    expect(day.input).toBe(5000);
    expect(day.cacheWrite).toBe(200);

    const ses = visible.find((r) => r.kind === "session")!;
    expect(ses.input).toBe(3000);
    expect(ses.cacheWrite).toBe(120);

    const prov = visible.find((r) => r.kind === "provider")!;
    expect(prov.input).toBe(3000);
    expect(prov.cacheWrite).toBe(120);

    const mod = visible.find((r) => r.kind === "model")!;
    expect(mod.input).toBe(3000);
    expect(mod.cacheWrite).toBe(120);
  });

  test("collapse cascade: expanding day then un-expanding it hides all children", () => {
    const rows = createVisibleRowsFixture();
    // First expand everything
    const fullyExpanded = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1"]),
      providers: new Set(["2025-12-15:ses-1:anthropic"]),
    });
    expect(fullyExpanded).toHaveLength(5);

    // Now collapse the day
    const collapsed = computeVisibleRows(rows, {
      days: new Set(), // day not expanded
      parentGroups: new Set(), // parentGroups still "expanded" but invisible
      sessions: new Set(["2025-12-15:ses-1"]), // session still "expanded" but invisible
      providers: new Set(["2025-12-15:ses-1:anthropic"]), // provider still "expanded" but invisible
    });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].kind).toBe("day");
  });
});

// ============================================================================
// reduceExpansion: pure reducer with cascade-close semantics
// ============================================================================

describe("reduceExpansion", () => {
  function cloneState(s: ExpansionState): ExpansionState {
    return {
      days: new Set(s.days),
      parentGroups: new Set(s.parentGroups),
      sessions: new Set(s.sessions),
      providers: new Set(s.providers),
    };
  }

  test("toggle day open", () => {
    const next = reduceExpansion(INITIAL_EXPANSION, {
      type: "TOGGLE_DAY",
      date: "2025-12-15",
    });
    expect(next.days.has("2025-12-15")).toBe(true);
    expect(INITIAL_EXPANSION.days.has("2025-12-15")).toBe(false); // original unchanged
  });

  test("toggle day closed removes sessions and providers under that day", () => {
    const state: ExpansionState = {
      days: new Set(["2025-12-15", "2025-12-16"]),
      parentGroups: new Set(),
      sessions: new Set([
        "2025-12-15:ses-1",
        "2025-12-15:ses-2",
        "2025-12-16:ses-3",
      ]),
      providers: new Set([
        "2025-12-15:ses-1:anthropic",
        "2025-12-16:ses-3:openai",
      ]),
    };

    const next = reduceExpansion(state, {
      type: "TOGGLE_DAY",
      date: "2025-12-15",
    });

    // 2025-12-15 removed
    expect(next.days.has("2025-12-15")).toBe(false);
    // 2025-12-16 preserved
    expect(next.days.has("2025-12-16")).toBe(true);
    // Sessions under 2025-12-15 removed, ses-3 preserved
    expect(next.sessions.has("2025-12-15:ses-1")).toBe(false);
    expect(next.sessions.has("2025-12-15:ses-2")).toBe(false);
    expect(next.sessions.has("2025-12-16:ses-3")).toBe(true);
    // Providers under 2025-12-15 removed, openai preserved
    expect(next.providers.has("2025-12-15:ses-1:anthropic")).toBe(false);
    expect(next.providers.has("2025-12-16:ses-3:openai")).toBe(true);
  });

  test("toggle day open after close restores", () => {
    const opened = reduceExpansion(INITIAL_EXPANSION, {
      type: "TOGGLE_DAY",
      date: "2025-12-15",
    });
    expect(opened.days.has("2025-12-15")).toBe(true);
    const closed = reduceExpansion(opened, {
      type: "TOGGLE_DAY",
      date: "2025-12-15",
    });
    expect(closed.days.has("2025-12-15")).toBe(false);
    const reopened = reduceExpansion(closed, {
      type: "TOGGLE_DAY",
      date: "2025-12-15",
    });
    expect(reopened.days.has("2025-12-15")).toBe(true);
  });

  test("toggle session closed removes providers under that session", () => {
    const state: ExpansionState = {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1", "2025-12-15:ses-2"]),
      providers: new Set([
        "2025-12-15:ses-1:anthropic",
        "2025-12-15:ses-1:openai",
        "2025-12-15:ses-2:anthropic",
      ]),
    };

    const next = reduceExpansion(state, {
      type: "TOGGLE_SESSION",
      sessionKey: "2025-12-15:ses-1",
    });

    expect(next.sessions.has("2025-12-15:ses-1")).toBe(false);
    expect(next.sessions.has("2025-12-15:ses-2")).toBe(true);
    // Providers under ses-1 removed, ses-2's provider preserved
    expect(next.providers.has("2025-12-15:ses-1:anthropic")).toBe(false);
    expect(next.providers.has("2025-12-15:ses-1:openai")).toBe(false);
    expect(next.providers.has("2025-12-15:ses-2:anthropic")).toBe(true);
  });

  test("toggle provider open and closed", () => {
    const open = reduceExpansion(INITIAL_EXPANSION, {
      type: "TOGGLE_PROVIDER",
      providerKey: "2025-12-15:ses-1:anthropic",
    });
    expect(open.providers.has("2025-12-15:ses-1:anthropic")).toBe(true);

    const closed = reduceExpansion(open, {
      type: "TOGGLE_PROVIDER",
      providerKey: "2025-12-15:ses-1:anthropic",
    });
    expect(closed.providers.has("2025-12-15:ses-1:anthropic")).toBe(false);
  });

  test("reducer does not mutate input state", () => {
    const original = cloneState(INITIAL_EXPANSION);
    reduceExpansion(INITIAL_EXPANSION, {
      type: "TOGGLE_DAY",
      date: "2025-12-15",
    });
    expect(INITIAL_EXPANSION.days.size).toBe(original.days.size);
    expect(INITIAL_EXPANSION.parentGroups.size).toBe(
      original.parentGroups.size
    );
    expect(INITIAL_EXPANSION.sessions.size).toBe(original.sessions.size);
    expect(INITIAL_EXPANSION.providers.size).toBe(original.providers.size);
  });

  test("multi-step: expand day, expand session, collapse session cascade-closes providers", () => {
    let state = INITIAL_EXPANSION;
    state = reduceExpansion(state, { type: "TOGGLE_DAY", date: "2025-12-15" });
    state = reduceExpansion(state, {
      type: "TOGGLE_SESSION",
      sessionKey: "2025-12-15:ses-1",
    });
    state = reduceExpansion(state, {
      type: "TOGGLE_PROVIDER",
      providerKey: "2025-12-15:ses-1:anthropic",
    });
    expect(state.providers.has("2025-12-15:ses-1:anthropic")).toBe(true);

    // Collapse session — provider should cascade-close
    state = reduceExpansion(state, {
      type: "TOGGLE_SESSION",
      sessionKey: "2025-12-15:ses-1",
    });
    expect(state.sessions.has("2025-12-15:ses-1")).toBe(false);
    expect(state.providers.has("2025-12-15:ses-1:anthropic")).toBe(false);
  });

  test("multi-step: collapse day cascade-closes both sessions and providers", () => {
    let state = INITIAL_EXPANSION;
    state = reduceExpansion(state, { type: "TOGGLE_DAY", date: "2025-12-15" });
    state = reduceExpansion(state, {
      type: "TOGGLE_SESSION",
      sessionKey: "2025-12-15:ses-1",
    });
    state = reduceExpansion(state, {
      type: "TOGGLE_PROVIDER",
      providerKey: "2025-12-15:ses-1:anthropic",
    });

    // Collapse day — everything under it should cascade-close
    state = reduceExpansion(state, { type: "TOGGLE_DAY", date: "2025-12-15" });
    expect(state.days.has("2025-12-15")).toBe(false);
    expect(state.sessions.has("2025-12-15:ses-1")).toBe(false);
    expect(state.providers.has("2025-12-15:ses-1:anthropic")).toBe(false);
  });

  test("toggle parent group open and closed", () => {
    const open = reduceExpansion(INITIAL_EXPANSION, {
      type: "TOGGLE_PARENT_GROUP",
      groupKey: "2025-12-15:p1",
    });
    expect(open.parentGroups.has("2025-12-15:p1")).toBe(true);

    const closed = reduceExpansion(open, {
      type: "TOGGLE_PARENT_GROUP",
      groupKey: "2025-12-15:p1",
    });
    expect(closed.parentGroups.has("2025-12-15:p1")).toBe(false);
  });

  test("toggle parent group closed cascade-closes sessions and providers under that group", () => {
    const state: ExpansionState = {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(["2025-12-15:p1", "2025-12-15:p2"]),
      sessions: new Set([
        "2025-12-15:p1:__own__",
        "2025-12-15:p1:c1",
        "2025-12-15:p2:__own__",
      ]),
      providers: new Set([
        "2025-12-15:p1:__own__:anthropic",
        "2025-12-15:p1:c1:openai",
        "2025-12-15:p2:__own__:anthropic",
      ]),
    };

    const next = reduceExpansion(state, {
      type: "TOGGLE_PARENT_GROUP",
      groupKey: "2025-12-15:p1",
    });

    expect(next.parentGroups.has("2025-12-15:p1")).toBe(false);
    expect(next.parentGroups.has("2025-12-15:p2")).toBe(true);
    // Sessions under p1 removed
    expect(next.sessions.has("2025-12-15:p1:__own__")).toBe(false);
    expect(next.sessions.has("2025-12-15:p1:c1")).toBe(false);
    // Sessions under p2 preserved
    expect(next.sessions.has("2025-12-15:p2:__own__")).toBe(true);
    // Providers under p1 removed
    expect(next.providers.has("2025-12-15:p1:__own__:anthropic")).toBe(false);
    expect(next.providers.has("2025-12-15:p1:c1:openai")).toBe(false);
    // Providers under p2 preserved
    expect(next.providers.has("2025-12-15:p2:__own__:anthropic")).toBe(true);
  });

  test("toggle day closed cascade-closes parent groups and their children", () => {
    const state: ExpansionState = {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(["2025-12-15:p1"]),
      sessions: new Set(["2025-12-15:p1:__own__", "2025-12-15:p1:c1"]),
      providers: new Set(["2025-12-15:p1:__own__:anthropic"]),
    };

    const next = reduceExpansion(state, {
      type: "TOGGLE_DAY",
      date: "2025-12-15",
    });

    expect(next.days.has("2025-12-15")).toBe(false);
    expect(next.parentGroups.has("2025-12-15:p1")).toBe(false);
    expect(next.sessions.has("2025-12-15:p1:__own__")).toBe(false);
    expect(next.sessions.has("2025-12-15:p1:c1")).toBe(false);
    expect(next.providers.has("2025-12-15:p1:__own__:anthropic")).toBe(false);
  });

  test("three-level session collapse clears descendant sessions/providers, reopen does not reveal stale descendants", () => {
    // Setup: grandparent → parent → child, all expanded with providers
    const state: ExpansionState = {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(["2025-12-15:gp"]),
      sessions: new Set([
        "2025-12-15:gp:__own__",
        "2025-12-15:gp:parent",
        "2025-12-15:gp:parent:child",
      ]),
      providers: new Set([
        "2025-12-15:gp:__own__:anthropic",
        "2025-12-15:gp:parent:openai",
        "2025-12-15:gp:parent:child:openai",
      ]),
    };

    // Collapse the intermediate "parent" session
    const afterCollapse = reduceExpansion(state, {
      type: "TOGGLE_SESSION",
      sessionKey: "2025-12-15:gp:parent",
    });

    // "parent" itself removed
    expect(afterCollapse.sessions.has("2025-12-15:gp:parent")).toBe(false);
    // Descendant "child" session removed
    expect(afterCollapse.sessions.has("2025-12-15:gp:parent:child")).toBe(
      false
    );
    // Providers under "parent" and "child" removed
    expect(afterCollapse.providers.has("2025-12-15:gp:parent:openai")).toBe(
      false
    );
    expect(
      afterCollapse.providers.has("2025-12-15:gp:parent:child:openai")
    ).toBe(false);
    // Own work under grandparent preserved
    expect(afterCollapse.sessions.has("2025-12-15:gp:__own__")).toBe(true);
    expect(afterCollapse.providers.has("2025-12-15:gp:__own__:anthropic")).toBe(
      true
    );

    // Re-open "parent" — descendant session/provider keys should NOT reappear
    // (they were deleted, not just hidden)
    const afterReopen = reduceExpansion(afterCollapse, {
      type: "TOGGLE_SESSION",
      sessionKey: "2025-12-15:gp:parent",
    });

    expect(afterReopen.sessions.has("2025-12-15:gp:parent")).toBe(true);
    // Descendant keys are gone — reopening does not restore them
    expect(afterReopen.sessions.has("2025-12-15:gp:parent:child")).toBe(false);
    expect(afterReopen.providers.has("2025-12-15:gp:parent:openai")).toBe(
      false
    );
    expect(afterReopen.providers.has("2025-12-15:gp:parent:child:openai")).toBe(
      false
    );
  });
});

// ============================================================================
// computeVisibleRows: source refs + hasChildren semantics
// ============================================================================

describe("computeVisibleRows source refs", () => {
  test("day row carries dayRow ref when it has sessions", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(),
      parentGroups: new Set(),
      sessions: new Set(),
      providers: new Set(),
    });
    const day = visible[0];
    expect(day.dayRow).toBeDefined();
    expect(day.dayRow!.date).toBe("2025-12-15");
    expect(day.dayRow!.sessionDetails).toHaveLength(2);
  });

  test("day row has no dayRow ref when no sessions", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.1,
        providers: [],
        providerDetails: [],
        sessionDetails: [],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];
    const visible = computeVisibleRows(rows, {
      days: new Set(),
      parentGroups: new Set(),
      sessions: new Set(),
      providers: new Set(),
    });
    expect(visible[0].dayRow).toBeUndefined();
  });

  test("session row carries sessionDetail ref when it has providers", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(),
      providers: new Set(),
    });
    const ses = visible.find((r) => r.kind === "session")!;
    expect(ses.sessionDetail).toBeDefined();
    expect(ses.sessionDetail!.providerDetails).toHaveLength(1);
    expect(ses.sessionDetail!.title).toBe("Fix auth");
  });

  test("session row has no sessionDetail ref when providers empty", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.1,
        providers: [],
        providerDetails: [],
        sessionDetails: [
          {
            sessionID: "ses-1",
            title: "Empty",
            input: 100,
            output: 50,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.1,
            providerDetails: [],
          },
        ],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(),
      providers: new Set(),
    });
    const ses = visible.find((r) => r.kind === "session")!;
    expect(ses.sessionDetail).toBeUndefined();
  });

  test("provider row carries providerDetail ref when it has models", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1"]),
      providers: new Set(),
    });
    const prov = visible.find((r) => r.kind === "provider")!;
    expect(prov.providerDetail).toBeDefined();
    expect(prov.providerDetail!.modelDetails).toHaveLength(1);
    expect(prov.providerDetail!.provider).toBe("anthropic");
  });

  test("provider row has no providerDetail ref when models empty", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.1,
        providers: [],
        providerDetails: [],
        sessionDetails: [
          {
            sessionID: "ses-1",
            title: "Ses",
            input: 100,
            output: 50,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.1,
            providerDetails: [
              {
                provider: "p1",
                input: 100,
                output: 50,
                cost: 0.1,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                models: ["m1"],
                modelDetails: [],
              },
            ],
          },
        ],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1"]),
      providers: new Set(),
    });
    const prov = visible.find((r) => r.kind === "provider")!;
    expect(prov.providerDetail).toBeUndefined();
  });

  test("model rows never carry source refs", () => {
    const rows = createVisibleRowsFixture();
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1"]),
      providers: new Set(["2025-12-15:ses-1:anthropic"]),
    });
    const models = visible.filter((r) => r.kind === "model");
    for (const m of models) {
      expect(m.dayRow).toBeUndefined();
      expect(m.sessionDetail).toBeUndefined();
      expect(m.providerDetail).toBeUndefined();
    }
  });

  test("visible rows match computeVisibleRows with reduceExpansion", () => {
    const rows = createVisibleRowsFixture();
    let state = INITIAL_EXPANSION;
    state = reduceExpansion(state, { type: "TOGGLE_DAY", date: "2025-12-15" });
    state = reduceExpansion(state, {
      type: "TOGGLE_SESSION",
      sessionKey: "2025-12-15:ses-1",
    });
    state = reduceExpansion(state, {
      type: "TOGGLE_PROVIDER",
      providerKey: "2025-12-15:ses-1:anthropic",
    });

    const visible = computeVisibleRows(rows, state);
    expect(visible.map((r) => r.kind)).toEqual([
      "day",
      "session",
      "provider",
      "model",
      "session",
    ]);
    expect(visible[3].label).toBe("claude-opus-4-5");
  });

  test("every visible row has a unique key, including duplicate model names across sessions", () => {
    // Construct data where the same model name "shared-model" appears under
    // two different sessions, each with a different provider. Both sessions
    // and both providers are fully expanded. This proves that the key
    // includes the full ancestor path and never collides.
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: ["shared-model"],
        inputTokens: 600,
        outputTokens: 300,
        totalTokens: 900,
        cost: 0.6,
        providers: ["provider-a", "provider-b"],
        providerDetails: [],
        sessionDetails: [
          {
            sessionID: "ses-1",
            title: "Session One",
            input: 300,
            output: 150,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.3,
            providerDetails: [
              {
                provider: "provider-a",
                input: 300,
                output: 150,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.3,
                models: ["shared-model"],
                modelDetails: [
                  {
                    model: "shared-model",
                    input: 300,
                    output: 150,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.3,
                  },
                ],
              },
            ],
          },
          {
            sessionID: "ses-2",
            title: "Session Two",
            input: 300,
            output: 150,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.3,
            providerDetails: [
              {
                provider: "provider-b",
                input: 300,
                output: 150,
                cacheWrite: 0,
                cacheRead: 0,
                reasoning: 0,
                cost: 0.3,
                models: ["shared-model"],
                modelDetails: [
                  {
                    model: "shared-model",
                    input: 300,
                    output: 150,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    cost: 0.3,
                  },
                ],
              },
            ],
          },
        ],
        parentGroups: [],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    // Fully expand everything
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(["2025-12-15:ses-1", "2025-12-15:ses-2"]),
      providers: new Set([
        "2025-12-15:ses-1:provider-a",
        "2025-12-15:ses-2:provider-b",
      ]),
    });

    // 1 day + 2 sessions + 2 providers + 2 models = 7
    expect(visible).toHaveLength(7);

    // Every key is unique
    const keys = visible.map((r) => r.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);

    // Verify the duplicate model names get distinct keys
    const models = visible.filter((r) => r.kind === "model");
    expect(models).toHaveLength(2);
    expect(models[0].label).toBe("shared-model");
    expect(models[1].label).toBe("shared-model");
    expect(models[0].key).not.toBe(models[1].key);

    // Verify key format includes full ancestor path
    expect(models[0].key).toBe(
      "model:2025-12-15:ses-1:provider-a:shared-model"
    );
    expect(models[1].key).toBe(
      "model:2025-12-15:ses-2:provider-b:shared-model"
    );

    // Verify day/session/provider keys also include ancestor scope
    const day = visible.find((r) => r.kind === "day")!;
    expect(day.key).toBe("day:2025-12-15");

    const sessions = visible.filter((r) => r.kind === "session");
    expect(sessions[0].key).toBe("session:2025-12-15:ses-1");
    expect(sessions[1].key).toBe("session:2025-12-15:ses-2");

    const providers = visible.filter((r) => r.kind === "provider");
    expect(providers[0].key).toBe("provider:2025-12-15:ses-1:provider-a");
    expect(providers[1].key).toBe("provider:2025-12-15:ses-2:provider-b");
  });
});

// ============================================================================
// computeVisibleRows: parent group hierarchy rendering
// ============================================================================

describe("computeVisibleRows parent groups", () => {
  test("parent group row appears when day is expanded", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.1,
        providers: [],
        providerDetails: [],
        sessionDetails: [],
        parentGroups: [
          {
            sessionID: "p1",
            title: "Parent (@orch)",
            agent: "orchestrator",
            classification: "parent",
            ownDetails: {
              sessionID: "p1",
              title: "Parent",
              input: 50,
              output: 25,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.05,
              providerDetails: [],
            },
            children: [],
            totalInput: 50,
            totalOutput: 25,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 0.05,
            totalProviderDetails: [],
          },
        ],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(),
      providers: new Set(),
    });
    expect(visible).toHaveLength(2);
    expect(visible[0].kind).toBe("day");
    expect(visible[1].kind).toBe("parent_group");
    expect(visible[1].label).toBe("Parent (@orch)");
  });

  test("expanding parent group shows own work and children", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 0.2,
        providers: [],
        providerDetails: [],
        sessionDetails: [],
        parentGroups: [
          {
            sessionID: "p1",
            title: "Parent",
            agent: null,
            classification: "parent",
            ownDetails: {
              sessionID: "p1",
              title: "Parent",
              input: 50,
              output: 25,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.05,
              providerDetails: [],
            },
            children: [
              {
                sessionID: "c1",
                title: "Child (@fixer)",
                agent: "fixer",
                ownDetails: {
                  sessionID: "c1",
                  title: "Child",
                  input: 150,
                  output: 75,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 0.15,
                  providerDetails: [],
                },
                details: {
                  sessionID: "c1",
                  title: "Child",
                  input: 150,
                  output: 75,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 0.15,
                  providerDetails: [],
                },
                children: [],
              },
            ],
            totalInput: 200,
            totalOutput: 100,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 0.2,
            totalProviderDetails: [],
          },
        ],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(["2025-12-15:p1"]),
      sessions: new Set(),
      providers: new Set(),
    });
    const kinds = visible.map((r) => r.kind);
    expect(kinds).toEqual(["day", "parent_group", "own_work", "child_session"]);
  });

  test("standalone sessions appear after parent groups", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
        cost: 0.3,
        providers: [],
        providerDetails: [],
        sessionDetails: [
          {
            sessionID: "standalone",
            title: "Standalone",
            input: 100,
            output: 50,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.1,
            providerDetails: [],
          },
        ],
        parentGroups: [
          {
            sessionID: "p1",
            title: "Parent",
            agent: null,
            classification: "parent",
            ownDetails: {
              sessionID: "p1",
              title: "Parent",
              input: 200,
              output: 100,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.2,
              providerDetails: [],
            },
            children: [],
            totalInput: 200,
            totalOutput: 100,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 0.2,
            totalProviderDetails: [],
          },
        ],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(),
      providers: new Set(),
    });
    expect(visible).toHaveLength(3);
    expect(visible[0].kind).toBe("day");
    expect(visible[1].kind).toBe("parent_group");
    expect(visible[2].kind).toBe("session");
    expect(visible[2].label).toBe("Standalone");
  });
});

// ============================================================================
// computeVisibleRows: focused tests for recursive hierarchy
// ============================================================================

describe("computeVisibleRows recursive hierarchy", () => {
  /** 3-level hierarchy: grandparent → parent → child */
  function createThreeLevelRows(): UsageRow[] {
    return [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 600,
        outputTokens: 300,
        totalTokens: 900,
        cost: 3.0,
        providers: [],
        providerDetails: [],
        sessionDetails: [],
        parentGroups: [
          {
            sessionID: "grandparent",
            title: "Grandparent (@orch)",
            agent: "orchestrator",
            classification: "parent",
            ownDetails: {
              sessionID: "grandparent",
              title: "Grandparent",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.5,
              providerDetails: [
                {
                  provider: "anthropic",
                  input: 100,
                  output: 50,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 0.5,
                  models: ["claude-opus-4-5"],
                  modelDetails: [
                    {
                      model: "claude-opus-4-5",
                      input: 100,
                      output: 50,
                      cacheWrite: 0,
                      cacheRead: 0,
                      reasoning: 0,
                      cost: 0.5,
                    },
                  ],
                },
              ],
            },
            children: [
              {
                sessionID: "parent",
                title: "Parent (@coordinator)",
                agent: "coordinator",
                ownDetails: {
                  sessionID: "parent",
                  title: "Parent",
                  input: 200,
                  output: 100,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 1.0,
                  providerDetails: [],
                },
                details: {
                  sessionID: "parent",
                  title: "Parent",
                  input: 200,
                  output: 100,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 1.0,
                  providerDetails: [],
                },
                children: [
                  {
                    sessionID: "child",
                    title: "Child (@fixer)",
                    agent: "fixer",
                    ownDetails: {
                      sessionID: "child",
                      title: "Child",
                      input: 300,
                      output: 150,
                      cacheWrite: 0,
                      cacheRead: 0,
                      reasoning: 0,
                      cost: 1.5,
                      providerDetails: [
                        {
                          provider: "openai",
                          input: 300,
                          output: 150,
                          cacheWrite: 0,
                          cacheRead: 0,
                          reasoning: 0,
                          cost: 1.5,
                          models: ["gpt-4o"],
                          modelDetails: [
                            {
                              model: "gpt-4o",
                              input: 300,
                              output: 150,
                              cacheWrite: 0,
                              cacheRead: 0,
                              reasoning: 0,
                              cost: 1.5,
                            },
                          ],
                        },
                      ],
                    },
                    details: {
                      sessionID: "child",
                      title: "Child",
                      input: 300,
                      output: 150,
                      cacheWrite: 0,
                      cacheRead: 0,
                      reasoning: 0,
                      cost: 1.5,
                      providerDetails: [
                        {
                          provider: "openai",
                          input: 300,
                          output: 150,
                          cacheWrite: 0,
                          cacheRead: 0,
                          reasoning: 0,
                          cost: 1.5,
                          models: ["gpt-4o"],
                          modelDetails: [
                            {
                              model: "gpt-4o",
                              input: 300,
                              output: 150,
                              cacheWrite: 0,
                              cacheRead: 0,
                              reasoning: 0,
                              cost: 1.5,
                            },
                          ],
                        },
                      ],
                    },
                    children: [],
                  },
                ],
              },
            ],
            totalInput: 600,
            totalOutput: 300,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 3.0,
            totalProviderDetails: [],
          },
        ],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];
  }

  test("three-level hierarchy: all levels expanded shows grandparent → own_work → parent → child → providers → models", () => {
    const rows = createThreeLevelRows();
    // Expand everything: day, grandparent, own_work, parent (child)
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(["2025-12-15:grandparent"]),
      sessions: new Set([
        "2025-12-15:grandparent:__own__",
        "2025-12-15:grandparent:parent",
        "2025-12-15:grandparent:parent:child",
      ]),
      providers: new Set([
        "2025-12-15:grandparent:__own__:anthropic",
        "2025-12-15:grandparent:parent:child:openai",
      ]),
    });

    const kinds = visible.map((r) => r.kind);
    const levels = visible.map((r) => r.level);

    // day → parent_group → own_work → provider → model
    //   → child_session(parent) → child_session(child) → provider → model
    expect(kinds).toEqual([
      "day",
      "parent_group",
      "own_work",
      "provider",
      "model",
      "child_session",
      "child_session",
      "provider",
      "model",
    ]);

    // Levels: 0, 1, 2, 3, 4, 2, 3, 4, 5
    expect(levels).toEqual([0, 1, 2, 3, 4, 2, 3, 4, 5]);
  });

  test("three-level hierarchy: child session shows nested providers when expanded", () => {
    const rows = createThreeLevelRows();
    // Expand: day, grandparent, parent child (not own_work)
    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(["2025-12-15:grandparent"]),
      sessions: new Set([
        "2025-12-15:grandparent:parent",
        "2025-12-15:grandparent:parent:child",
      ]),
      providers: new Set(["2025-12-15:grandparent:parent:child:openai"]),
    });

    // day + parent_group + own_work + child_session(parent) + child_session(child) + provider + model
    const kinds = visible.map((r) => r.kind);
    expect(kinds).toEqual([
      "day",
      "parent_group",
      "own_work",
      "child_session",
      "child_session",
      "provider",
      "model",
    ]);

    // The child's openai provider is at level 4, model at level 5
    const provider = visible.find(
      (r) => r.kind === "provider" && r.label === "openai"
    );
    expect(provider).toBeDefined();
    expect(provider!.level).toBe(4);

    const model = visible.find(
      (r) => r.kind === "model" && r.label === "gpt-4o"
    );
    expect(model).toBeDefined();
    expect(model!.level).toBe(5);
  });

  test("child session exclusion: descendant sessions excluded from standalone", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 600,
        outputTokens: 300,
        totalTokens: 900,
        cost: 3.0,
        providers: [],
        providerDetails: [],
        sessionDetails: [
          // These session IDs appear in the parent tree
          {
            sessionID: "parent",
            title: "Parent",
            input: 200,
            output: 100,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 1.0,
            providerDetails: [],
          },
          {
            sessionID: "child",
            title: "Child",
            input: 300,
            output: 150,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 1.5,
            providerDetails: [],
          },
          // This session is NOT in the parent tree
          {
            sessionID: "standalone",
            title: "Standalone",
            input: 100,
            output: 50,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0.5,
            providerDetails: [],
          },
        ],
        parentGroups: [
          {
            sessionID: "grandparent",
            title: "Grandparent",
            agent: null,
            classification: "parent",
            ownDetails: {
              sessionID: "grandparent",
              title: "Grandparent",
              input: 0,
              output: 0,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0,
              providerDetails: [],
            },
            children: [
              {
                sessionID: "parent",
                title: "Parent",
                agent: null,
                ownDetails: {
                  sessionID: "parent",
                  title: "Parent",
                  input: 200,
                  output: 100,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 1.0,
                  providerDetails: [],
                },
                details: {
                  sessionID: "parent",
                  title: "Parent",
                  input: 200,
                  output: 100,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 1.0,
                  providerDetails: [],
                },
                children: [
                  {
                    sessionID: "child",
                    title: "Child",
                    agent: null,
                    ownDetails: {
                      sessionID: "child",
                      title: "Child",
                      input: 300,
                      output: 150,
                      cacheWrite: 0,
                      cacheRead: 0,
                      reasoning: 0,
                      cost: 1.5,
                      providerDetails: [],
                    },
                    details: {
                      sessionID: "child",
                      title: "Child",
                      input: 300,
                      output: 150,
                      cacheWrite: 0,
                      cacheRead: 0,
                      reasoning: 0,
                      cost: 1.5,
                      providerDetails: [],
                    },
                    children: [],
                  },
                ],
              },
            ],
            totalInput: 600,
            totalOutput: 300,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 3.0,
            totalProviderDetails: [],
          },
        ],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(),
      sessions: new Set(),
      providers: new Set(),
    });

    // Should show: day, parent_group, and the standalone session
    // "parent" and "child" should NOT appear as standalone sessions
    const sessionLabels = visible
      .filter((r) => r.kind === "session")
      .map((r) => r.label);
    expect(sessionLabels).toEqual(["Standalone"]);
  });

  test("recursive key uniqueness: same session/model names at different depths get unique keys", () => {
    const rows: UsageRow[] = [
      {
        date: "2025-12-15",
        models: [],
        inputTokens: 600,
        outputTokens: 300,
        totalTokens: 900,
        cost: 3.0,
        providers: [],
        providerDetails: [],
        sessionDetails: [],
        parentGroups: [
          {
            sessionID: "p1",
            title: "Group 1",
            agent: null,
            classification: "parent",
            ownDetails: {
              sessionID: "p1",
              title: "Group 1",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.5,
              providerDetails: [
                {
                  provider: "anthropic",
                  input: 100,
                  output: 50,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 0.5,
                  models: ["shared-model"],
                  modelDetails: [
                    {
                      model: "shared-model",
                      input: 100,
                      output: 50,
                      cacheWrite: 0,
                      cacheRead: 0,
                      reasoning: 0,
                      cost: 0.5,
                    },
                  ],
                },
              ],
            },
            children: [
              {
                sessionID: "c1",
                title: "Child (@fixer)",
                agent: "fixer",
                ownDetails: {
                  sessionID: "c1",
                  title: "Child",
                  input: 200,
                  output: 100,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 1.0,
                  providerDetails: [
                    {
                      provider: "anthropic",
                      input: 200,
                      output: 100,
                      cacheWrite: 0,
                      cacheRead: 0,
                      reasoning: 0,
                      cost: 1.0,
                      models: ["shared-model"],
                      modelDetails: [
                        {
                          model: "shared-model",
                          input: 200,
                          output: 100,
                          cacheWrite: 0,
                          cacheRead: 0,
                          reasoning: 0,
                          cost: 1.0,
                        },
                      ],
                    },
                  ],
                },
                details: {
                  sessionID: "c1",
                  title: "Child",
                  input: 200,
                  output: 100,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 1.0,
                  providerDetails: [
                    {
                      provider: "anthropic",
                      input: 200,
                      output: 100,
                      cacheWrite: 0,
                      cacheRead: 0,
                      reasoning: 0,
                      cost: 1.0,
                      models: ["shared-model"],
                      modelDetails: [
                        {
                          model: "shared-model",
                          input: 200,
                          output: 100,
                          cacheWrite: 0,
                          cacheRead: 0,
                          reasoning: 0,
                          cost: 1.0,
                        },
                      ],
                    },
                  ],
                },
                children: [],
              },
            ],
            totalInput: 300,
            totalOutput: 150,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 1.5,
            totalProviderDetails: [],
          },
          {
            sessionID: "p2",
            title: "Group 2",
            agent: null,
            classification: "parent",
            ownDetails: {
              sessionID: "p2",
              title: "Group 2",
              input: 100,
              output: 50,
              cacheWrite: 0,
              cacheRead: 0,
              reasoning: 0,
              cost: 0.5,
              providerDetails: [
                {
                  provider: "anthropic",
                  input: 100,
                  output: 50,
                  cacheWrite: 0,
                  cacheRead: 0,
                  reasoning: 0,
                  cost: 0.5,
                  models: ["shared-model"],
                  modelDetails: [
                    {
                      model: "shared-model",
                      input: 100,
                      output: 50,
                      cacheWrite: 0,
                      cacheRead: 0,
                      reasoning: 0,
                      cost: 0.5,
                    },
                  ],
                },
              ],
            },
            children: [],
            totalInput: 100,
            totalOutput: 50,
            totalCacheWrite: 0,
            totalCacheRead: 0,
            totalReasoning: 0,
            totalCost: 0.5,
            totalProviderDetails: [],
          },
        ],
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
      },
    ];

    const visible = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(["2025-12-15:p1", "2025-12-15:p2"]),
      sessions: new Set(["2025-12-15:p1:__own__", "2025-12-15:p1:c1"]),
      providers: new Set([
        "2025-12-15:p1:__own__:anthropic",
        "2025-12-15:p1:c1:anthropic",
        "2025-12-15:p2:__own__:anthropic",
      ]),
    });

    // All keys must be unique
    const keys = visible.map((r) => r.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);

    // Verify model keys include full ancestor path
    const models = visible.filter((r) => r.kind === "model");
    expect(models.length).toBeGreaterThanOrEqual(2);

    // The 3 models named "shared-model" should have distinct keys
    const modelKeys = models.filter((r) => r.label === "shared-model");
    const modelKeySet = new Set(modelKeys.map((r) => r.key));
    expect(modelKeySet.size).toBe(modelKeys.length);

    // Verify provider keys include full ancestor path
    const providers = visible.filter((r) => r.kind === "provider");
    const providerKeySet = new Set(providers.map((r) => r.key));
    expect(providerKeySet.size).toBe(providers.length);
  });

  test("cascade-close: collapsing grandparent removes all descendant session/provider keys", () => {
    const rows = createThreeLevelRows();

    // Fully expanded
    const expanded = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(["2025-12-15:grandparent"]),
      sessions: new Set([
        "2025-12-15:grandparent:__own__",
        "2025-12-15:grandparent:parent",
        "2025-12-15:grandparent:parent:child",
      ]),
      providers: new Set([
        "2025-12-15:grandparent:__own__:anthropic",
        "2025-12-15:grandparent:parent:child:openai",
      ]),
    });
    expect(expanded.length).toBeGreaterThan(2);

    // Collapse the parent group (simulate cascade from reducer)
    const collapsed = computeVisibleRows(rows, {
      days: new Set(["2025-12-15"]),
      parentGroups: new Set(), // grandparent collapsed
      sessions: new Set([
        // These are "stale" but invisible — parent group is collapsed
        "2025-12-15:grandparent:__own__",
        "2025-12-15:grandparent:parent",
        "2025-12-15:grandparent:parent:child",
      ]),
      providers: new Set([
        "2025-12-15:grandparent:__own__:anthropic",
        "2025-12-15:grandparent:parent:child:openai",
      ]),
    });

    // Only day + parent_group should be visible
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0].kind).toBe("day");
    expect(collapsed[1].kind).toBe("parent_group");
  });

  test("cascade-close: collapsing day removes all parent groups and their descendants", () => {
    const rows = createThreeLevelRows();

    const collapsed = computeVisibleRows(rows, {
      days: new Set(), // day collapsed
      parentGroups: new Set(["2025-12-15:grandparent"]),
      sessions: new Set([
        "2025-12-15:grandparent:__own__",
        "2025-12-15:grandparent:parent",
        "2025-12-15:grandparent:parent:child",
      ]),
      providers: new Set([
        "2025-12-15:grandparent:__own__:anthropic",
        "2025-12-15:grandparent:parent:child:openai",
      ]),
    });

    // Only day row
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].kind).toBe("day");
  });
});
