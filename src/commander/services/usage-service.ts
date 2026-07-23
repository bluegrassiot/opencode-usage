/**
 * Usage data service — thin wrapper over loader + aggregator for the Commander API.
 */

import {
  loadMessages,
  getOpenCodeStoragePath,
  loadSessions,
} from "../../loader.js";
import {
  aggregateByDate,
  aggregateByMonth,
  buildParentTrees,
  filterByDays,
  filterByDateRange,
} from "../../aggregator.js";
import type {
  DailyStats,
  ParentTreeClassification,
  ParentTreeNode,
  ProviderStats,
  SessionStats,
} from "../../types.js";

export type UsageQueryOpts = {
  provider?: string;
  days?: number;
  since?: string;
  until?: string;
  monthly?: boolean;
};

export type UsageResponse = {
  days: SerializedDailyStats[];
  sessions: Record<
    string,
    {
      title: string;
      slug: string;
      parentId: string | null;
      agent: string | null;
    }
  >;
};

export type SerializedModelStats = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  cost: number;
};

export type SerializedProviderStats = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  cost: number;
  models: string[];
  modelStats: Record<string, SerializedModelStats>;
};

export type SerializedSessionProviderStats = SerializedProviderStats;

export type SerializedSessionStats = {
  sessionID: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  cost: number;
  providerStats: Record<string, SerializedSessionProviderStats>;
};

export type SerializedParentTreeNode = {
  sessionID: string;
  title: string;
  agent: string | null;
  classification: ParentTreeClassification;
  ownStats: SerializedSessionStats;
  children: SerializedParentTreeNode[];
  totalStats: SerializedSessionStats;
};

export type SerializedDailyStats = {
  date: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  cost: number;
  models: string[];
  providers: string[];
  providerStats: Record<string, SerializedProviderStats>;
  sessionStats: Record<string, SerializedSessionStats>;
  parentGroups: SerializedParentTreeNode[];
};

function serializeProviderStats(ps: ProviderStats): SerializedProviderStats {
  const modelStats: Record<string, SerializedModelStats> = {};
  for (const [id, ms] of ps.modelStats) {
    modelStats[id] = {
      input: ms.input,
      output: ms.output,
      cacheWrite: ms.cacheWrite,
      cacheRead: ms.cacheRead,
      reasoning: ms.reasoning,
      cost: ms.cost,
    };
  }

  return {
    input: ps.input,
    output: ps.output,
    cacheWrite: ps.cacheWrite,
    cacheRead: ps.cacheRead,
    reasoning: ps.reasoning,
    cost: ps.cost,
    models: [...ps.models],
    modelStats,
  };
}

function serializeSessionStats(ss: SessionStats): SerializedSessionStats {
  const sessionProviderStats: Record<string, SerializedSessionProviderStats> =
    {};
  for (const [pid, ps] of ss.providerStats) {
    sessionProviderStats[pid] = serializeProviderStats(ps);
  }
  return {
    sessionID: ss.sessionID,
    input: ss.input,
    output: ss.output,
    cacheWrite: ss.cacheWrite,
    cacheRead: ss.cacheRead,
    reasoning: ss.reasoning,
    cost: ss.cost,
    providerStats: sessionProviderStats,
  };
}

function serializeParentTreeNode(
  node: ParentTreeNode
): SerializedParentTreeNode {
  return {
    sessionID: node.sessionID,
    title: node.title,
    agent: node.agent,
    classification: node.classification,
    ownStats: serializeSessionStats(node.ownStats),
    children: node.children.map(serializeParentTreeNode),
    totalStats: serializeSessionStats(node.totalStats),
  };
}

function serializeDailyStats(stats: DailyStats): SerializedDailyStats {
  const providerStats: Record<string, SerializedProviderStats> = {};
  for (const [id, ps] of stats.providerStats) {
    providerStats[id] = serializeProviderStats(ps);
  }

  const sessionStats: Record<string, SerializedSessionStats> = {};
  for (const [id, ss] of stats.sessionStats) {
    sessionStats[id] = serializeSessionStats(ss);
  }

  return {
    date: stats.date,
    input: stats.input,
    output: stats.output,
    cacheWrite: stats.cacheWrite,
    cacheRead: stats.cacheRead,
    reasoning: stats.reasoning,
    cost: stats.cost,
    models: [...stats.models],
    providers: [...stats.providers],
    providerStats,
    sessionStats,
    parentGroups: [],
  };
}

export async function getUsageData(
  opts: UsageQueryOpts = {}
): Promise<UsageResponse> {
  const storagePath = getOpenCodeStoragePath();
  const messages = await loadMessages(storagePath, opts.provider);
  const sessionMap = loadSessions(storagePath);
  let stats = aggregateByDate(messages);

  if (opts.days !== undefined) {
    stats = filterByDays(stats, opts.days);
  }

  if (opts.since !== undefined || opts.until !== undefined) {
    stats = filterByDateRange(stats, opts.since, opts.until);
  }

  if (opts.monthly) {
    stats = aggregateByMonth(stats);
  }

  // Build parent trees for each day (only for non-monthly view)
  const parentGroupsByDay = new Map<string, ParentTreeNode[]>();
  if (!opts.monthly) {
    for (const [date, dayStats] of stats) {
      parentGroupsByDay.set(
        date,
        buildParentTrees(dayStats.sessionStats, sessionMap)
      );
    }
  }

  const result: SerializedDailyStats[] = [];
  for (const [date, entry] of stats) {
    const serialized = serializeDailyStats(entry);
    const parentTrees = parentGroupsByDay.get(date) ?? [];
    serialized.parentGroups = parentTrees.map(serializeParentTreeNode);
    result.push(serialized);
  }

  const sessions: Record<
    string,
    {
      title: string;
      slug: string;
      parentId: string | null;
      agent: string | null;
    }
  > = {};
  for (const [id, info] of sessionMap) {
    sessions[id] = {
      title: info.title,
      slug: info.slug,
      parentId: info.parentId,
      agent: info.agent,
    };
  }

  return { days: result, sessions };
}
