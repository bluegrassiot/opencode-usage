/**
 * Data aggregation functions
 */

import type {
  DailyStats,
  MessageJson,
  ModelStats,
  ParentTreeClassification,
  ParentTreeNode,
  ProviderStats,
  SessionStats,
  TokenUsage,
} from "./types.js";
import type { SessionInfo } from "./loader.js";
import { calculateCost } from "./pricing";

function timestampToDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[0];
}

// ---- Shared helpers for provider/model get-or-create and accumulation ----

function getOrCreateProvider(
  map: Map<string, ProviderStats>,
  providerId: string
): ProviderStats {
  let ps = map.get(providerId);
  if (!ps) {
    ps = {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 0,
      models: new Set(),
      modelStats: new Map(),
    };
    map.set(providerId, ps);
  }
  return ps;
}

function getOrCreateModel(
  map: Map<string, ModelStats>,
  modelId: string
): ModelStats {
  let ms = map.get(modelId);
  if (!ms) {
    ms = {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 0,
    };
    map.set(modelId, ms);
  }
  return ms;
}

function accumulateMetrics(
  target: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    reasoning: number;
    cost: number;
  },
  tokens: TokenUsage,
  cost: number
): void {
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheWrite += tokens.cache.write;
  target.cacheRead += tokens.cache.read;
  target.reasoning += tokens.reasoning;
  target.cost += cost;
}

function accumulateProviderModel(
  providerStats: Map<string, ProviderStats>,
  providerId: string,
  modelId: string,
  tokens: TokenUsage,
  cost: number
): void {
  const ps = getOrCreateProvider(providerStats, providerId);
  ps.models.add(modelId);
  accumulateMetrics(ps, tokens, cost);

  const ms = getOrCreateModel(ps.modelStats, modelId);
  accumulateMetrics(ms, tokens, cost);
}

// ---- Aggregation ----

export function aggregateByDate(
  messages: MessageJson[]
): Map<string, DailyStats> {
  const dailyStats = new Map<string, DailyStats>();

  for (const msg of messages) {
    const timestamp = msg.time?.created ?? msg.time?.completed;
    if (!timestamp) continue;

    const date = timestampToDate(timestamp);
    const modelId = msg.model?.modelID ?? msg.modelID ?? "unknown";
    const providerId = msg.model?.providerID ?? msg.providerID ?? "unknown";
    const tokens = msg.tokens!;
    const msgCost = calculateCost(tokens, modelId);

    let stats = dailyStats.get(date);
    if (!stats) {
      stats = {
        date,
        models: new Set(),
        providers: new Set(),
        providerStats: new Map(),
        sessionStats: new Map(),
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 0,
      };
      dailyStats.set(date, stats);
    }

    // Update daily totals
    stats.models.add(modelId);
    stats.providers.add(providerId);
    accumulateMetrics(stats, tokens, msgCost);

    // Update session-specific stats
    const sessionId = msg.sessionID || "__unknown__";
    let sessionStat = stats.sessionStats.get(sessionId);
    if (!sessionStat) {
      sessionStat = {
        sessionID: sessionId,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 0,
        providerStats: new Map(),
      };
      stats.sessionStats.set(sessionId, sessionStat);
    }
    accumulateMetrics(sessionStat, tokens, msgCost);

    // Update session → provider → model (shared helper)
    accumulateProviderModel(
      sessionStat.providerStats,
      providerId,
      modelId,
      tokens,
      msgCost
    );

    // Update day → provider → model (shared helper)
    accumulateProviderModel(
      stats.providerStats,
      providerId,
      modelId,
      tokens,
      msgCost
    );
  }

  return dailyStats;
}

export function filterByDays(
  dailyStats: Map<string, DailyStats>,
  days: number
): Map<string, DailyStats> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days + 1);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const filtered = new Map<string, DailyStats>();
  for (const [date, stats] of dailyStats) {
    if (date >= cutoffStr) {
      filtered.set(date, stats);
    }
  }
  return filtered;
}

export function filterByDateRange(
  dailyStats: Map<string, DailyStats>,
  since?: string,
  until?: string
): Map<string, DailyStats> {
  const filtered = new Map<string, DailyStats>();
  for (const [date, stats] of dailyStats) {
    if (since && date < since) continue;
    if (until && date > until) continue;
    filtered.set(date, stats);
  }
  return filtered;
}

function dateToMonth(date: string): string {
  return date.slice(0, 7); // YYYY-MM
}

export function aggregateByMonth(
  dailyStats: Map<string, DailyStats>
): Map<string, DailyStats> {
  const monthlyStats = new Map<string, DailyStats>();

  for (const [date, stats] of dailyStats) {
    const month = dateToMonth(date);

    let monthStats = monthlyStats.get(month);
    if (!monthStats) {
      monthStats = {
        date: month,
        models: new Set(),
        providers: new Set(),
        providerStats: new Map(),
        sessionStats: new Map(),
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        cost: 0,
      };
      monthlyStats.set(month, monthStats);
    }

    // Merge models and providers
    for (const model of stats.models) monthStats.models.add(model);
    for (const provider of stats.providers) monthStats.providers.add(provider);

    // Sum totals
    monthStats.input += stats.input;
    monthStats.output += stats.output;
    monthStats.cacheWrite += stats.cacheWrite;
    monthStats.cacheRead += stats.cacheRead;
    monthStats.reasoning += stats.reasoning;
    monthStats.cost += stats.cost;

    // Merge provider stats
    for (const [providerId, providerStat] of stats.providerStats) {
      let monthProviderStat = monthStats.providerStats.get(providerId);
      if (!monthProviderStat) {
        monthProviderStat = {
          input: 0,
          output: 0,
          cacheWrite: 0,
          cacheRead: 0,
          reasoning: 0,
          cost: 0,
          models: new Set(),
          modelStats: new Map(),
        };
        monthStats.providerStats.set(providerId, monthProviderStat);
      }
      for (const model of providerStat.models)
        monthProviderStat.models.add(model);
      monthProviderStat.input += providerStat.input;
      monthProviderStat.output += providerStat.output;
      monthProviderStat.cacheWrite += providerStat.cacheWrite;
      monthProviderStat.cacheRead += providerStat.cacheRead;
      monthProviderStat.reasoning += providerStat.reasoning;
      monthProviderStat.cost += providerStat.cost;

      // Merge per-model stats within the provider
      for (const [modelId, ms] of providerStat.modelStats) {
        let monthModelStat = monthProviderStat.modelStats.get(modelId);
        if (!monthModelStat) {
          monthModelStat = {
            input: 0,
            output: 0,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
            cost: 0,
          };
          monthProviderStat.modelStats.set(modelId, monthModelStat);
        }
        monthModelStat.input += ms.input;
        monthModelStat.output += ms.output;
        monthModelStat.cacheWrite += ms.cacheWrite;
        monthModelStat.cacheRead += ms.cacheRead;
        monthModelStat.reasoning += ms.reasoning;
        monthModelStat.cost += ms.cost;
      }
    }
  }

  return monthlyStats;
}

// ---- Parent tree building ----

export function buildParentTrees(
  sessionStats: Map<string, SessionStats>,
  sessionInfo: Map<string, SessionInfo>
): ParentTreeNode[] {
  // Step 1: Collect active sessions (those with usage data).
  // Only active sessions and the metadata ancestors needed to connect them
  // are included — unrelated metadata-only siblings/history are excluded.
  const activeSids = new Set(sessionStats.keys());

  // Step 2: Walk parentId chains from active sessions to find required
  // ancestors.  A metadata-only session is included only if it is an
  // ancestor of at least one active session.
  const includedSids = new Set(activeSids);
  for (const sid of activeSids) {
    let current = sid;
    while (true) {
      const info = sessionInfo.get(current);
      if (!info) break;
      const parentId = info.parentId;
      if (
        !parentId ||
        parentId === "" ||
        parentId === current ||
        parentId === "__unknown__" ||
        !sessionInfo.has(parentId)
      )
        break;
      if (includedSids.has(parentId)) break; // already included (or cycle)
      includedSids.add(parentId);
      current = parentId;
    }
  }

  // Step 3: Detect cycles among included sessions via parentId chain walk.
  const inCycle = new Set<string>();
  const cycleVisited = new Set<string>();
  const visiting = new Set<string>();

  function detectCycle(sid: string): void {
    if (cycleVisited.has(sid)) return;
    if (visiting.has(sid)) {
      // Found a cycle — walk the chain to mark all cycle members
      let current = sid;
      while (!inCycle.has(current)) {
        inCycle.add(current);
        const info = sessionInfo.get(current);
        current = info?.parentId ?? "";
      }
      return;
    }
    visiting.add(sid);
    const info = sessionInfo.get(sid);
    const parentId = info?.parentId;
    if (parentId && includedSids.has(parentId)) {
      detectCycle(parentId);
    }
    visiting.delete(sid);
    cycleVisited.add(sid);
  }

  for (const sid of includedSids) {
    detectCycle(sid);
  }

  // Step 4: Build children map and identify roots.
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  const orphanSids = new Set<string>();

  for (const sid of includedSids) {
    if (sid === "__unknown__" || inCycle.has(sid)) {
      roots.push(sid);
      continue;
    }

    const info = sessionInfo.get(sid);
    const parentId = info?.parentId;

    if (
      !parentId ||
      parentId === "" ||
      parentId === sid ||
      parentId === "__unknown__" ||
      !includedSids.has(parentId)
    ) {
      roots.push(sid);
      // If parentId was set but the parent is missing, mark as orphan
      if (
        parentId &&
        parentId !== "" &&
        parentId !== sid &&
        parentId !== "__unknown__" &&
        !includedSids.has(parentId)
      ) {
        orphanSids.add(sid);
      }
    } else {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId)!.push(sid);
    }
  }

  // Step 5: Build trees via DFS with ancestry tracking.
  const globalVisited = new Set<string>();

  function classify(sid: string, childCount: number): ParentTreeClassification {
    if (sid === "__unknown__") return "unknown";
    if (orphanSids.has(sid)) return "orphan";
    if (childCount > 0) return "parent";
    return "standalone";
  }

  function buildTree(
    sid: string,
    ancestry: Set<string>
  ): ParentTreeNode | null {
    if (globalVisited.has(sid)) return null;
    if (ancestry.has(sid)) {
      // Cycle detected — promote to root (handled by caller)
      return null;
    }

    globalVisited.add(sid);
    const newAncestry = new Set(ancestry);
    newAncestry.add(sid);

    const info = sessionInfo.get(sid);
    const ownStats = sessionStats.get(sid) ?? createZeroedSessionStats(sid);

    const childIds = childrenOf.get(sid) ?? [];
    const children: ParentTreeNode[] = [];
    for (const cid of childIds) {
      const child = buildTree(cid, newAncestry);
      if (child) children.push(child);
    }
    children.sort((a, b) => b.totalStats.cost - a.totalStats.cost);

    const totalStats = mergeSessionStats(
      ownStats,
      children.map((c) => c.totalStats)
    );

    return {
      sessionID: sid,
      title: info?.title ?? sid,
      agent: info?.agent ?? null,
      classification: classify(sid, children.length),
      ownStats,
      children,
      totalStats,
    };
  }

  // Build all root trees
  const trees: ParentTreeNode[] = [];
  for (const rid of roots) {
    const tree = buildTree(rid, new Set());
    if (tree) trees.push(tree);
  }

  // Handle orphans (remaining unvisited nodes)
  for (const sid of includedSids) {
    if (!globalVisited.has(sid)) {
      const tree = buildTree(sid, new Set());
      if (tree) trees.push(tree);
    }
  }

  trees.sort((a, b) => b.totalStats.cost - a.totalStats.cost);
  return trees;
}

function createZeroedSessionStats(sessionID: string): SessionStats {
  return {
    sessionID,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    reasoning: 0,
    cost: 0,
    providerStats: new Map(),
  };
}

function mergeSessionStats(
  base: SessionStats,
  others: SessionStats[]
): SessionStats {
  const result: SessionStats = {
    sessionID: base.sessionID,
    input: base.input,
    output: base.output,
    cacheWrite: base.cacheWrite,
    cacheRead: base.cacheRead,
    reasoning: base.reasoning,
    cost: base.cost,
    providerStats: new Map(),
  };

  // Copy base providerStats
  for (const [pid, ps] of base.providerStats) {
    result.providerStats.set(pid, cloneProviderStats(ps));
  }

  // Merge others
  for (const other of others) {
    result.input += other.input;
    result.output += other.output;
    result.cacheWrite += other.cacheWrite;
    result.cacheRead += other.cacheRead;
    result.reasoning += other.reasoning;
    result.cost += other.cost;

    for (const [pid, ops] of other.providerStats) {
      const existing = result.providerStats.get(pid);
      if (existing) {
        existing.input += ops.input;
        existing.output += ops.output;
        existing.cacheWrite += ops.cacheWrite;
        existing.cacheRead += ops.cacheRead;
        existing.reasoning += ops.reasoning;
        existing.cost += ops.cost;
        for (const m of ops.models) existing.models.add(m);
        for (const [mid, oms] of ops.modelStats) {
          const em = existing.modelStats.get(mid);
          if (em) {
            em.input += oms.input;
            em.output += oms.output;
            em.cacheWrite += oms.cacheWrite;
            em.cacheRead += oms.cacheRead;
            em.reasoning += oms.reasoning;
            em.cost += oms.cost;
          } else {
            existing.modelStats.set(mid, { ...oms });
          }
        }
      } else {
        result.providerStats.set(pid, cloneProviderStats(ops));
      }
    }
  }

  return result;
}

function cloneProviderStats(ps: ProviderStats): ProviderStats {
  const modelStats = new Map<string, ModelStats>();
  for (const [mid, ms] of ps.modelStats) {
    modelStats.set(mid, { ...ms });
  }
  return {
    input: ps.input,
    output: ps.output,
    cacheWrite: ps.cacheWrite,
    cacheRead: ps.cacheRead,
    reasoning: ps.reasoning,
    cost: ps.cost,
    models: new Set(ps.models),
    modelStats,
  };
}
