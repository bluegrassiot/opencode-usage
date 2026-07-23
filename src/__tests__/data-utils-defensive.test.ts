import { describe, test, expect } from "bun:test";
import { parseUsageRows } from "../commander-ui/src/lib/data-utils.js";

describe("parseUsageRows defensive guards", () => {
  test("returns [] for null input", () => {
    expect(parseUsageRows(null)).toEqual([]);
  });

  test("returns [] for undefined input", () => {
    expect(parseUsageRows(undefined)).toEqual([]);
  });

  test("returns [] for primitive input", () => {
    expect(parseUsageRows("string")).toEqual([]);
    expect(parseUsageRows(42)).toEqual([]);
    expect(parseUsageRows(true)).toEqual([]);
  });

  test("returns [] for { days } with non-array days", () => {
    expect(parseUsageRows({ days: "not-array" })).toEqual([]);
    expect(parseUsageRows({ days: null })).toEqual([]);
    expect(parseUsageRows({ days: 123 })).toEqual([]);
  });

  test("skips null/non-record day rows in array", () => {
    const data = [
      null,
      42,
      "string",
      {
        date: "2025-12-15",
        input: 100,
        output: 50,
        cost: 0.01,
        models: [],
        providers: [],
        providerStats: {},
        sessionStats: {},
      },
    ];
    const rows = parseUsageRows(data);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2025-12-15");
  });

  test("skips null/non-record day rows in { days } shape", () => {
    const data = {
      days: [null, { date: "2025-12-15", cost: 0.01 }],
    };
    const rows = parseUsageRows(data);
    expect(rows).toHaveLength(1);
  });

  test("handles null sessionStats gracefully", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0.01,
        sessionStats: null,
      },
    ];
    const rows = parseUsageRows(data);
    expect(rows[0].sessionDetails).toEqual([]);
  });

  test("handles null providerStats gracefully", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0.01,
        providerStats: null,
      },
    ];
    const rows = parseUsageRows(data);
    expect(rows[0].providerDetails).toEqual([]);
  });

  test("skips non-record session stat entries", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          cost: 0.3,
          sessionStats: {
            "ses-good": { sessionID: "ses-good", input: 100, cost: 0.1 },
            "ses-null": null,
            "ses-num": 42,
          },
        },
      ],
    };
    const rows = parseUsageRows(data);
    expect(rows[0].sessionDetails).toHaveLength(1);
    expect(rows[0].sessionDetails[0].sessionID).toBe("ses-good");
  });

  test("handles non-record provider stat entries with zeroed values", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0.1,
        providerStats: {
          good: { input: 100, cost: 0.1 },
          bad: null,
        },
      },
    ];
    const rows = parseUsageRows(data);
    expect(rows[0].providerDetails).toHaveLength(2);
    const good = rows[0].providerDetails.find((p) => p.provider === "good")!;
    const bad = rows[0].providerDetails.find((p) => p.provider === "bad")!;
    expect(good.input).toBe(100);
    expect(bad.input).toBe(0);
    expect(bad.cost).toBe(0);
  });

  test("handles non-record session metadata gracefully", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          cost: 0.1,
          sessionStats: {
            "ses-1": { sessionID: "ses-1", input: 100, cost: 0.1 },
          },
        },
      ],
      sessions: {
        "ses-1": null,
      },
    };
    const rows = parseUsageRows(data);
    // Falls back to sessionID since metadata is invalid
    expect(rows[0].sessionDetails[0].title).toBe("ses-1");
  });

  test("coerces non-string title/slug to strings via fallback", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          cost: 0.1,
          sessionStats: {
            "ses-1": { sessionID: "ses-1", input: 100, cost: 0.1 },
          },
        },
      ],
      sessions: {
        "ses-1": { title: 123, slug: true },
      },
    };
    const rows = parseUsageRows(data);
    // typeof 123 !== "string" so rawTitle = "", typeof true !== "string" so rawSlug = ""
    // Falls back to sessionID
    expect(rows[0].sessionDetails[0].title).toBe("ses-1");
  });

  test("handles empty sessions map in { days, sessions } shape", () => {
    const data = {
      days: [
        {
          date: "2025-12-15",
          cost: 0.1,
          sessionStats: {
            "ses-1": { sessionID: "ses-1", cost: 0.1 },
          },
        },
      ],
      sessions: {},
    };
    const rows = parseUsageRows(data);
    expect(rows[0].sessionDetails[0].title).toBe("ses-1");
  });
});

describe("session-level providerStats defensive guards", () => {
  test("non-record provider entries: mixed with valid and as sole provider", () => {
    // Sub-case 1: mixed — valid entry alongside broken entry
    const mixedData = [
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
            providerStats: {
              good: {
                input: 100,
                output: 50,
                cost: 0.1,
                models: [],
                modelStats: {},
              },
              bad: null,
            },
          },
        },
      },
    ];

    const mixedRows = parseUsageRows(mixedData);
    const mixedProviders = mixedRows[0].sessionDetails[0].providerDetails;

    // Valid entry preserved alongside broken entry
    expect(mixedProviders).toHaveLength(2);
    const good = mixedProviders.find((p) => p.provider === "good")!;
    expect(good.input).toBe(100);
    expect(good.output).toBe(50);
    expect(good.cost).toBe(0.1);

    // Non-record entry produces fully zeroed ProviderDetail
    const bad = mixedProviders.find((p) => p.provider === "bad")!;
    expect(bad.input).toBe(0);
    expect(bad.output).toBe(0);
    expect(bad.cacheWrite).toBe(0);
    expect(bad.cacheRead).toBe(0);
    expect(bad.reasoning).toBe(0);
    expect(bad.cost).toBe(0);
    expect(bad.models).toEqual([]);
    expect(bad.modelDetails).toEqual([]);

    // Sub-case 2: sole — broken entry is the only provider
    const soleData = [
      {
        date: "2025-12-15",
        input: 50,
        output: 25,
        cost: 0.05,
        models: [],
        providers: [],
        providerStats: {},
        sessionStats: {
          ses: {
            sessionID: "ses",
            input: 50,
            output: 25,
            cost: 0.05,
            providerStats: {
              broken: null,
            },
          },
        },
      },
    ];

    const soleRows = parseUsageRows(soleData);
    const soleProviders = soleRows[0].sessionDetails[0].providerDetails;

    expect(soleProviders).toHaveLength(1);
    expect(soleProviders[0].provider).toBe("broken");
    expect(soleProviders[0].input).toBe(0);
    expect(soleProviders[0].output).toBe(0);
    expect(soleProviders[0].cacheWrite).toBe(0);
    expect(soleProviders[0].cacheRead).toBe(0);
    expect(soleProviders[0].reasoning).toBe(0);
    expect(soleProviders[0].cost).toBe(0);
    expect(soleProviders[0].models).toEqual([]);
    expect(soleProviders[0].modelDetails).toEqual([]);
  });

  test("filters out non-record modelStats entries inside session provider", () => {
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
          ses: {
            sessionID: "ses",
            input: 100,
            output: 50,
            cost: 0.1,
            providerStats: {
              p: {
                input: 100,
                output: 50,
                cost: 0.1,
                models: ["m1", "m2"],
                modelStats: {
                  m1: {
                    input: 100,
                    output: 50,
                    cost: 0.1,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                  },
                  m2: null,
                },
              },
            },
          },
        },
      },
    ];

    const rows = parseUsageRows(data);
    const models = rows[0].sessionDetails[0].providerDetails[0].modelDetails;
    // null entries are filtered out by isRecord check
    expect(models).toHaveLength(1);
    expect(models[0].model).toBe("m1");
    expect(models[0].input).toBe(100);
  });

  test("handles __unknown__ session with providerStats", () => {
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

    const rows = parseUsageRows(data);
    const ses = rows[0].sessionDetails[0];
    expect(ses.title).toBe("Unknown session");
    expect(ses.providerDetails).toHaveLength(1);
    expect(ses.providerDetails[0].provider).toBe("anthropic");
    expect(ses.providerDetails[0].modelDetails).toHaveLength(1);
    expect(ses.providerDetails[0].modelDetails[0].model).toBe("m1");
  });
});

// ============================================================================
// Malformed numeric and model name guards
// ============================================================================

describe("malformed numeric guards", () => {
  test("NaN/Infinity/undefined/null in metric fields produce 0", () => {
    const data = [
      {
        date: "2025-12-15",
        input: NaN,
        output: Infinity,
        cost: -Infinity,
        cacheWrite: undefined,
        cacheRead: null,
        reasoning: "not-a-number",
        models: [],
        providers: [],
        providerStats: {},
        sessionStats: {},
      },
    ];
    const rows = parseUsageRows(data);
    expect(rows[0].inputTokens).toBe(0);
    expect(rows[0].outputTokens).toBe(0);
    expect(rows[0].cost).toBe(0);
    expect(rows[0].cacheWrite).toBe(0);
    expect(rows[0].cacheRead).toBe(0);
    expect(rows[0].reasoning).toBe(0);
  });

  test("NaN/Infinity in provider metric fields produce 0", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0,
        providerStats: {
          p: {
            input: NaN,
            output: Infinity,
            cost: -Infinity,
            cacheWrite: "bad",
            cacheRead: null,
            reasoning: undefined,
            models: [],
            modelStats: {},
          },
        },
        sessionStats: {},
      },
    ];
    const rows = parseUsageRows(data);
    const pd = rows[0].providerDetails[0];
    expect(pd.input).toBe(0);
    expect(pd.output).toBe(0);
    expect(pd.cost).toBe(0);
    expect(pd.cacheWrite).toBe(0);
    expect(pd.cacheRead).toBe(0);
    expect(pd.reasoning).toBe(0);
  });

  test("NaN/Infinity in model metric fields produce 0", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0,
        providerStats: {
          p: {
            cost: 0,
            models: [],
            modelStats: {
              m: {
                input: NaN,
                output: Infinity,
                cost: -Infinity,
                cacheWrite: "nope",
                cacheRead: null,
                reasoning: undefined,
              },
            },
          },
        },
        sessionStats: {},
      },
    ];
    const rows = parseUsageRows(data);
    const md = rows[0].providerDetails[0].modelDetails[0];
    expect(md.input).toBe(0);
    expect(md.output).toBe(0);
    expect(md.cost).toBe(0);
    expect(md.cacheWrite).toBe(0);
    expect(md.cacheRead).toBe(0);
    expect(md.reasoning).toBe(0);
  });

  test("NaN/Infinity in session metric fields produce 0", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0,
        providerStats: {},
        sessionStats: {
          ses: {
            sessionID: "ses",
            input: NaN,
            output: Infinity,
            cost: -Infinity,
            cacheWrite: "bad",
            cacheRead: null,
            reasoning: undefined,
          },
        },
      },
    ];
    const rows = parseUsageRows(data);
    const ses = rows[0].sessionDetails[0];
    expect(ses.input).toBe(0);
    expect(ses.output).toBe(0);
    expect(ses.cost).toBe(0);
    expect(ses.cacheWrite).toBe(0);
    expect(ses.cacheRead).toBe(0);
    expect(ses.reasoning).toBe(0);
  });

  test("NaN/Infinity in session providerStats metric fields produce 0", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0,
        providerStats: {},
        sessionStats: {
          ses: {
            sessionID: "ses",
            input: 0,
            cost: 0,
            providerStats: {
              p: {
                input: NaN,
                output: Infinity,
                cost: -Infinity,
                models: [],
                modelStats: {},
              },
            },
          },
        },
      },
    ];
    const rows = parseUsageRows(data);
    const pd = rows[0].sessionDetails[0].providerDetails[0];
    expect(pd.input).toBe(0);
    expect(pd.output).toBe(0);
    expect(pd.cost).toBe(0);
  });
});

describe("malformed model name guards", () => {
  test("non-string entries in provider models array are filtered out", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0,
        providerStats: {
          p: {
            cost: 0,
            input: 0,
            output: 0,
            models: [
              "valid" as unknown,
              null,
              42,
              undefined,
              true,
              { x: 1 },
            ] as unknown[],
            modelStats: {},
          },
        },
        sessionStats: {},
      },
    ];
    const rows = parseUsageRows(data);
    expect(rows[0].providerDetails[0].models).toEqual(["valid"]);
  });

  test("non-string entries in day-level models array are filtered out", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0,
        models: ["good" as unknown, null, 42, undefined] as unknown[],
        providerStats: {},
        sessionStats: {},
      },
    ];
    const rows = parseUsageRows(data);
    expect(rows[0].models).toEqual(["good"]);
  });

  test("non-string entries in providers array are filtered out", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0,
        providers: ["anthropic" as unknown, null, 42] as unknown[],
        providerStats: {},
        sessionStats: {},
      },
    ];
    const rows = parseUsageRows(data);
    expect(rows[0].providers).toEqual(["anthropic"]);
  });

  test("non-string entries in session provider models array are filtered out", () => {
    const data = [
      {
        date: "2025-12-15",
        cost: 0,
        providerStats: {},
        sessionStats: {
          ses: {
            sessionID: "ses",
            input: 0,
            cost: 0,
            providerStats: {
              p: {
                cost: 0,
                input: 0,
                output: 0,
                models: ["m1" as unknown, null, 99] as unknown[],
                modelStats: {},
              },
            },
          },
        },
      },
    ];
    const rows = parseUsageRows(data);
    expect(rows[0].sessionDetails[0].providerDetails[0].models).toEqual(["m1"]);
  });
});
