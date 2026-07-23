export type ModelDetail = {
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  cost: number;
};

export type ProviderDetail = {
  provider: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  cost: number;
  models: string[];
  modelDetails: ModelDetail[];
};

export type SessionDetail = {
  sessionID: string;
  title: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  cost: number;
  providerDetails: ProviderDetail[];
};

export type ChildSession = {
  sessionID: string;
  title: string;
  agent: string | null;
  /** The node's own work (direct token usage by this session only). */
  ownDetails: SessionDetail;
  /** Aggregate rollup: this node's own work plus all descendants. */
  details: SessionDetail;
  children: ChildSession[];
};

export type ParentTreeClassification =
  | "parent"
  | "standalone"
  | "orphan"
  | "unknown";

export type ParentGroup = {
  sessionID: string;
  title: string;
  agent: string | null;
  classification: ParentTreeClassification;
  ownDetails: SessionDetail;
  children: ChildSession[];
  totalInput: number;
  totalOutput: number;
  totalCacheWrite: number;
  totalCacheRead: number;
  totalReasoning: number;
  totalCost: number;
  totalProviderDetails: ProviderDetail[];
};

export type UsageRow = {
  date: string;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  providers: string[];
  providerDetails: ProviderDetail[];
  sessionDetails: SessionDetail[];
  parentGroups: ParentGroup[];
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
};

export type QuotaEntry = {
  provider: string;
  used: number;
  limit: number;
  percentage: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce to a finite number; NaN/Infinity → 0. */
function finite(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/** Filter to only string entries (guards against malformed JSON arrays). */
function stringsOnly(arr: unknown[]): string[] {
  return arr.filter((v): v is string => typeof v === "string");
}

/**
 * Reusable defensive parser for providerStats → ProviderDetail[].
 * Handles non-record entries (null, primitives) by zeroing their values.
 * Sorts providers and their modelDetails by cost descending.
 */
function parseProviderDetails(
  providerStatsRaw: Record<string, unknown>
): ProviderDetail[] {
  return Object.entries(providerStatsRaw)
    .map(([id, ps]) => {
      if (!isRecord(ps)) {
        return {
          provider: id,
          input: 0,
          output: 0,
          cacheWrite: 0,
          cacheRead: 0,
          reasoning: 0,
          cost: 0,
          models: [],
          modelDetails: [],
        };
      }

      const modelStats = isRecord(ps.modelStats)
        ? (ps.modelStats as Record<string, Record<string, unknown>>)
        : {};

      const modelDetails: ModelDetail[] = Object.entries(modelStats)
        .filter((entry): entry is [string, Record<string, unknown>] =>
          isRecord(entry[1])
        )
        .map(([model, ms]) => ({
          model,
          input: finite(ms.input),
          output: finite(ms.output),
          cacheWrite: finite(ms.cacheWrite),
          cacheRead: finite(ms.cacheRead),
          reasoning: finite(ms.reasoning),
          cost: finite(ms.cost),
        }))
        .sort((a, b) => b.cost - a.cost);

      return {
        provider: id,
        input: finite(ps.input),
        output: finite(ps.output),
        cacheWrite: finite(ps.cacheWrite),
        cacheRead: finite(ps.cacheRead),
        reasoning: finite(ps.reasoning),
        cost: finite(ps.cost),
        models: Array.isArray(ps.models) ? stringsOnly(ps.models) : [],
        modelDetails,
      };
    })
    .sort((a, b) => b.cost - a.cost);
}

/**
 * Parse an agent string: trim whitespace, reject whitespace-only or empty.
 */
function parseSafeAgent(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * Resolve a session title from sessions metadata with fallback chain:
 * metadata title → metadata slug → sessionID.
 * __unknown__ gets a fixed label. Trims whitespace from metadata fields.
 */
function resolveSessionTitle(
  sessionID: string,
  sessions: Record<string, unknown>
): string {
  if (sessionID === "__unknown__") return "Unknown session";
  const meta = isRecord(sessions[sessionID]) ? sessions[sessionID] : undefined;
  const rawTitle = typeof meta?.title === "string" ? meta.title.trim() : "";
  const rawSlug = typeof meta?.slug === "string" ? meta.slug.trim() : "";
  if (rawTitle && rawTitle !== rawSlug) return rawTitle;
  if (rawSlug) return rawSlug;
  return sessionID;
}

/**
 * Resolve a node title for parent groups and child nodes.
 * Fallback chain: trimmed non-empty raw API node title → sessions metadata
 * title → metadata slug → sessionID.
 * __unknown__ gets a fixed label regardless of raw title.
 */
function resolveNodeTitle(
  rawApiTitle: unknown,
  sessionID: string,
  sessions: Record<string, unknown>
): string {
  if (sessionID === "__unknown__") return "Unknown session";
  const trimmed = typeof rawApiTitle === "string" ? rawApiTitle.trim() : "";
  if (trimmed) return trimmed;
  return resolveSessionTitle(sessionID, sessions);
}

/**
 * Format a display title with optional @agent suffix.
 */
function formatNodeTitle(rawTitle: string, agent: string | null): string {
  return agent ? `${rawTitle} (@${agent})` : rawTitle;
}

/**
 * Defensive parser for a sessionStats-like raw object into SessionDetail.
 * Accepts an optional sessionID override (for when the ID comes from a
 * map key rather than the object's own sessionID field).
 */
function parseSessionDetailFromRaw(
  ss: Record<string, unknown>,
  sessions: Record<string, unknown>,
  sessionID?: string
): SessionDetail {
  const sid =
    sessionID ?? (typeof ss.sessionID === "string" ? ss.sessionID.trim() : "");
  const title = resolveSessionTitle(sid, sessions);

  const sesProviderStats = isRecord(ss.providerStats)
    ? (ss.providerStats as Record<string, unknown>)
    : {};

  return {
    sessionID: sid,
    title,
    input: finite(ss.input),
    output: finite(ss.output),
    cacheWrite: finite(ss.cacheWrite),
    cacheRead: finite(ss.cacheRead),
    reasoning: finite(ss.reasoning),
    cost: finite(ss.cost),
    providerDetails: parseProviderDetails(sesProviderStats),
  };
}

/**
 * Recursively parse a child node (child or grandchild etc.) from raw data.
 * Returns null if sessionID is empty/whitespace. Preserves arbitrary nesting depth.
 *
 * Accepts a recursive single-node shape with both ownStats (the node's own
 * work) and totalStats (rollup of own + all descendants).
 */
function parseChildNode(
  raw: Record<string, unknown>,
  sessions: Record<string, unknown>
): ChildSession | null {
  const sessionID =
    typeof raw.sessionID === "string" ? raw.sessionID.trim() : "";
  if (!sessionID) return null;

  const agent = parseSafeAgent(raw.agent);
  const rawTitle = resolveNodeTitle(raw.title, sessionID, sessions);
  const title = formatNodeTitle(rawTitle, agent);

  const ownStatsRaw = isRecord(raw.ownStats) ? raw.ownStats : {};
  const ownDetails = parseSessionDetailFromRaw(
    ownStatsRaw,
    sessions,
    sessionID
  );

  const totalStatsRaw = isRecord(raw.totalStats) ? raw.totalStats : {};
  const details = parseSessionDetailFromRaw(totalStatsRaw, sessions, sessionID);

  const childrenRaw = Array.isArray(raw.children) ? raw.children : [];
  const children = childrenRaw
    .filter((c): c is Record<string, unknown> => isRecord(c))
    .map((c) => parseChildNode(c, sessions))
    .filter((c): c is ChildSession => c !== null)
    .sort((a, b) => b.details.cost - a.details.cost);

  return { sessionID, title, agent, ownDetails, details, children };
}

export function parseUsageRows(data: unknown): UsageRow[] {
  // Handle new { days, sessions } shape
  let days: unknown[];
  let sessions: Record<string, unknown> = {};
  if (isRecord(data) && "days" in data) {
    days = Array.isArray(data.days) ? data.days : [];
    sessions = isRecord(data.sessions) ? data.sessions : {};
  } else if (Array.isArray(data)) {
    days = data;
  } else {
    return [];
  }

  return days
    .filter((r): r is Record<string, unknown> => isRecord(r))
    .map((r) => {
      const providerStats = isRecord(r.providerStats)
        ? (r.providerStats as Record<string, Record<string, unknown>>)
        : {};
      const providerDetails = parseProviderDetails(providerStats);

      // Parse session stats (reuse parseSessionDetailFromRaw for centralized logic)
      const sessionStatsRaw = isRecord(r.sessionStats)
        ? (r.sessionStats as Record<string, unknown>)
        : {};
      const sessionDetails: SessionDetail[] = Object.entries(sessionStatsRaw)
        .filter(
          (entry): entry is [string, Record<string, unknown>] =>
            isRecord(entry[1]) && entry[0].trim().length > 0
        )
        .map(([sid, ss]) => parseSessionDetailFromRaw(ss, sessions, sid))
        .sort((a, b) => b.cost - a.cost);

      // Parse parent groups
      const parentGroupsRaw = Array.isArray(r.parentGroups)
        ? r.parentGroups
        : [];
      const parentGroups: ParentGroup[] = parentGroupsRaw
        .filter((pg): pg is Record<string, unknown> => isRecord(pg))
        .map((pg) => {
          const sessionID =
            typeof pg.sessionID === "string" ? pg.sessionID.trim() : "";
          if (!sessionID) return null;

          const agent = parseSafeAgent(pg.agent);
          const rawTitle = resolveNodeTitle(pg.title, sessionID, sessions);
          const title = formatNodeTitle(rawTitle, agent);

          const ownStatsRaw = isRecord(pg.ownStats) ? pg.ownStats : {};
          const ownDetails = parseSessionDetailFromRaw(
            ownStatsRaw,
            sessions,
            sessionID
          );

          const childrenRaw = Array.isArray(pg.children) ? pg.children : [];
          const children = childrenRaw
            .filter((c): c is Record<string, unknown> => isRecord(c))
            .map((c) => parseChildNode(c, sessions))
            .filter((c): c is ChildSession => c !== null)
            .sort((a, b) => b.details.cost - a.details.cost);

          const totalRaw = isRecord(pg.totalStats) ? pg.totalStats : {};
          const totalProviderStats = isRecord(totalRaw.providerStats)
            ? (totalRaw.providerStats as Record<string, unknown>)
            : {};

          const classification: ParentTreeClassification =
            pg.classification === "parent" ||
            pg.classification === "standalone" ||
            pg.classification === "orphan" ||
            pg.classification === "unknown"
              ? pg.classification
              : "standalone";

          return {
            sessionID,
            title,
            agent,
            classification,
            ownDetails,
            children,
            totalInput: finite(totalRaw.input),
            totalOutput: finite(totalRaw.output),
            totalCacheWrite: finite(totalRaw.cacheWrite),
            totalCacheRead: finite(totalRaw.cacheRead),
            totalReasoning: finite(totalRaw.reasoning),
            totalCost: finite(totalRaw.cost),
            totalProviderDetails: parseProviderDetails(totalProviderStats),
          };
        })
        .filter((pg): pg is ParentGroup => pg !== null)
        .sort((a, b) => b.totalCost - a.totalCost);

      return {
        date: String(r.date ?? ""),
        models: Array.isArray(r.models)
          ? stringsOnly(r.models)
          : [String(r.model ?? "")],
        inputTokens: finite(r.inputTokens ?? r.input),
        outputTokens: finite(r.outputTokens ?? r.output),
        totalTokens: finite(r.totalTokens ?? r.total_tokens),
        cost: finite(r.cost),
        providers: Array.isArray(r.providers) ? stringsOnly(r.providers) : [],
        providerDetails,
        sessionDetails,
        parentGroups,
        cacheWrite: finite(r.cacheWrite),
        cacheRead: finite(r.cacheRead),
        reasoning: finite(r.reasoning),
      };
    })
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}

export function parseQuotaEntries(data: unknown): QuotaEntry[] {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data.map((q: Record<string, unknown>) => ({
      provider: String(q.provider ?? ""),
      used: finite(q.used),
      limit: finite(q.limit),
      percentage: finite(q.percentage),
    }));
  }
  if (typeof data === "object" && data !== null) {
    return Object.entries(data as Record<string, unknown>).map(([key, val]) => {
      const v = val as Record<string, unknown>;
      return {
        provider: key,
        used: finite(v.used),
        limit: finite(v.limit),
        percentage: finite(v.percentage),
      };
    });
  }
  return [];
}

export function aggregateMonthly(rows: UsageRow[]): UsageRow[] {
  const map = new Map<string, UsageRow>();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const existing = map.get(month);
    if (existing) {
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.totalTokens += row.totalTokens;
      existing.cost += row.cost;
      existing.cacheWrite += row.cacheWrite;
      existing.cacheRead += row.cacheRead;
      existing.reasoning += row.reasoning;
      existing.sessionDetails = [];
      existing.parentGroups = [];
      for (const m of row.models) {
        if (!existing.models.includes(m)) existing.models.push(m);
      }
      for (const p of row.providers) {
        if (!existing.providers.includes(p)) existing.providers.push(p);
      }
      // Merge provider details
      for (const pd of row.providerDetails) {
        const ep = existing.providerDetails.find(
          (e) => e.provider === pd.provider
        );
        if (ep) {
          ep.input += pd.input;
          ep.output += pd.output;
          ep.cacheWrite += pd.cacheWrite;
          ep.cacheRead += pd.cacheRead;
          ep.reasoning += pd.reasoning;
          ep.cost += pd.cost;
          for (const m of pd.models) {
            if (!ep.models.includes(m)) ep.models.push(m);
          }
          // Merge per-model details
          for (const md of pd.modelDetails) {
            const em = ep.modelDetails.find((e) => e.model === md.model);
            if (em) {
              em.input += md.input;
              em.output += md.output;
              em.cacheWrite += md.cacheWrite;
              em.cacheRead += md.cacheRead;
              em.reasoning += md.reasoning;
              em.cost += md.cost;
            } else {
              ep.modelDetails.push({ ...md });
            }
          }
          // Re-sort after accumulated costs may have changed ordering
          ep.modelDetails.sort((a, b) => b.cost - a.cost);
        } else {
          existing.providerDetails.push({
            ...pd,
            models: [...pd.models],
            modelDetails: pd.modelDetails.map((md) => ({ ...md })),
          });
        }
      }
      // Re-sort providers after accumulated costs may have changed ordering
      existing.providerDetails.sort((a, b) => b.cost - a.cost);
    } else {
      map.set(month, {
        ...row,
        date: month,
        sessionDetails: [],
        parentGroups: [],
        models: [...row.models],
        providers: [...row.providers],
        providerDetails: row.providerDetails.map((pd) => ({
          ...pd,
          models: [...pd.models],
          modelDetails: pd.modelDetails.map((md) => ({ ...md })),
        })),
      });
    }
  }
  return Array.from(map.values());
}

// ============================================================================
// Expansion state + pure reducer (testable without React)
// ============================================================================

export type ExpansionState = {
  days: Set<string>;
  parentGroups: Set<string>;
  sessions: Set<string>;
  providers: Set<string>;
};

export type ExpansionAction =
  | { type: "TOGGLE_DAY"; date: string }
  | { type: "TOGGLE_PARENT_GROUP"; groupKey: string }
  | { type: "TOGGLE_SESSION"; sessionKey: string }
  | { type: "TOGGLE_PROVIDER"; providerKey: string };

export const INITIAL_EXPANSION: ExpansionState = {
  days: new Set(),
  parentGroups: new Set(),
  sessions: new Set(),
  providers: new Set(),
};

/**
 * Pure reducer for expansion state with cascade-close semantics.
 * Collapsing a day removes all parent groups, sessions, and providers keyed under it.
 * Collapsing a parent group removes all sessions/providers keyed under it.
 * Collapsing a session removes all providers keyed under it.
 */
export function reduceExpansion(
  state: ExpansionState,
  action: ExpansionAction
): ExpansionState {
  switch (action.type) {
    case "TOGGLE_DAY": {
      const next = new Set(state.days);
      if (next.has(action.date)) {
        next.delete(action.date);
        const prefix = `${action.date}:`;
        const nextParentGroups = new Set(state.parentGroups);
        const nextSessions = new Set(state.sessions);
        const nextProviders = new Set(state.providers);
        for (const k of nextParentGroups) {
          if (k.startsWith(prefix)) nextParentGroups.delete(k);
        }
        for (const k of nextSessions) {
          if (k.startsWith(prefix)) nextSessions.delete(k);
        }
        for (const k of nextProviders) {
          if (k.startsWith(prefix)) nextProviders.delete(k);
        }
        return {
          days: next,
          parentGroups: nextParentGroups,
          sessions: nextSessions,
          providers: nextProviders,
        };
      }
      next.add(action.date);
      return { ...state, days: next };
    }
    case "TOGGLE_PARENT_GROUP": {
      const next = new Set(state.parentGroups);
      if (next.has(action.groupKey)) {
        next.delete(action.groupKey);
        const prefix = `${action.groupKey}:`;
        const nextSessions = new Set(state.sessions);
        const nextProviders = new Set(state.providers);
        for (const k of nextSessions) {
          if (k.startsWith(prefix)) nextSessions.delete(k);
        }
        for (const k of nextProviders) {
          if (k.startsWith(prefix)) nextProviders.delete(k);
        }
        return {
          ...state,
          parentGroups: next,
          sessions: nextSessions,
          providers: nextProviders,
        };
      }
      next.add(action.groupKey);
      return { ...state, parentGroups: next };
    }
    case "TOGGLE_SESSION": {
      const next = new Set(state.sessions);
      if (next.has(action.sessionKey)) {
        next.delete(action.sessionKey);
        const prefix = `${action.sessionKey}:`;
        // Cascade-close descendant sessions and providers
        const nextSessions = new Set(next);
        for (const k of nextSessions) {
          if (k.startsWith(prefix)) nextSessions.delete(k);
        }
        const nextProviders = new Set(state.providers);
        for (const k of nextProviders) {
          if (k.startsWith(prefix)) nextProviders.delete(k);
        }
        return { ...state, sessions: nextSessions, providers: nextProviders };
      }
      next.add(action.sessionKey);
      return { ...state, sessions: next };
    }
    case "TOGGLE_PROVIDER": {
      const next = new Set(state.providers);
      if (next.has(action.providerKey)) {
        next.delete(action.providerKey);
      } else {
        next.add(action.providerKey);
      }
      return { ...state, providers: next };
    }
  }
}

// ============================================================================
// Visible row computation (for deterministic UI order testing)
// ============================================================================

export type VisibleRowKind =
  | "day"
  | "parent_group"
  | "own_work"
  | "child_session"
  | "session"
  | "provider"
  | "model";

export type VisibleRow = {
  kind: VisibleRowKind;
  /** Indentation level: 0=day, 1=session, 2=provider, 3=model */
  level: number;
  /** Display label (date, session title, provider name, or model name) */
  label: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  cost: number;
  /** Classification of the parent group or session. */
  classification?: ParentTreeClassification;
  /**
   * Globally unique key for React rendering.
   * Includes the full ancestor path so that duplicate labels (e.g. same
   * model name under different sessions) never collide.
   *
   * Format:
   *   day:     `day:{date}`
   *   session: `session:{date}:{sessionID}`
   *   provider: `provider:{date}:{sessionID}:{provider}`
   *   model:   `model:{date}:{sessionID}:{provider}:{model}`
   */
  key: string;
  /**
   * Composite expansion key for this row's level.
   * - day: row.date
   * - session: `${date}:${sessionID}`
   * - provider: `${date}:${sessionID}:${provider}`
   * - model: absent (models are leaves)
   */
  expandKey?: string;
  /** Source data refs — only present when the row is expandable (has children) */
  dayRow?: UsageRow;
  sessionDetail?: SessionDetail;
  providerDetail?: ProviderDetail;
  parentGroup?: ParentGroup;
  childSession?: ChildSession;
};

/**
 * Recursively collect all descendant session IDs from ChildSession trees.
 */
function collectDescendantSessionIds(children: ChildSession[]): string[] {
  const ids: string[] = [];
  for (const c of children) {
    ids.push(c.sessionID);
    ids.push(...collectDescendantSessionIds(c.children));
  }
  return ids;
}

/**
 * Recursively render a child session and its nested children/ providers/ models.
 * Uses ownDetails for the child's own work display.
 */
function renderChildSession(
  cs: ChildSession,
  parentKey: string,
  level: number,
  expandedSessions: Set<string>,
  expandedProviders: Set<string>,
  result: VisibleRow[]
): void {
  const csKey = `${parentKey}:${cs.sessionID}`;
  const csExpanded = expandedSessions.has(csKey);
  const ownWork = cs.ownDetails ?? cs.details;
  const csHasProviders = ownWork.providerDetails.length > 0;
  const csHasDeeperChildren = cs.children.length > 0;

  result.push({
    kind: "child_session",
    level,
    label: cs.title,
    input: ownWork.input,
    output: ownWork.output,
    cacheWrite: ownWork.cacheWrite,
    cacheRead: ownWork.cacheRead,
    reasoning: ownWork.reasoning,
    cost: ownWork.cost,
    key: `child_session:${csKey}`,
    expandKey: csKey,
    childSession: cs,
    ...(csHasProviders || csHasDeeperChildren
      ? { sessionDetail: ownWork }
      : undefined),
  });

  if (csExpanded) {
    // Render own work providers for this child
    for (const prov of ownWork.providerDetails) {
      const provKey = `${csKey}:${prov.provider}`;
      const provExpanded = expandedProviders.has(provKey);
      result.push({
        kind: "provider",
        level: level + 1,
        label: prov.provider,
        input: prov.input,
        output: prov.output,
        cacheWrite: prov.cacheWrite,
        cacheRead: prov.cacheRead,
        reasoning: prov.reasoning,
        cost: prov.cost,
        key: `provider:${provKey}`,
        expandKey: provKey,
        ...(prov.modelDetails.length > 0
          ? { providerDetail: prov }
          : undefined),
      });
      if (provExpanded) {
        for (const mod of prov.modelDetails) {
          result.push({
            kind: "model",
            level: level + 2,
            label: mod.model,
            input: mod.input,
            output: mod.output,
            cacheWrite: mod.cacheWrite,
            cacheRead: mod.cacheRead,
            reasoning: mod.reasoning,
            cost: mod.cost,
            key: `model:${provKey}:${mod.model}`,
          });
        }
      }
    }

    // Recursively render nested children (grandchildren, etc.)
    for (const nestedChild of cs.children) {
      renderChildSession(
        nestedChild,
        csKey,
        level + 1,
        expandedSessions,
        expandedProviders,
        result
      );
    }
  }
}

/**
 * Render providers and models for a session detail at a given level.
 * Used for both own work and standalone sessions.
 */
function renderSessionProviders(
  details: SessionDetail,
  baseKey: string,
  level: number,
  expandedProviders: Set<string>,
  result: VisibleRow[]
): void {
  for (const prov of details.providerDetails) {
    const provKey = `${baseKey}:${prov.provider}`;
    const provExpanded = expandedProviders.has(provKey);
    result.push({
      kind: "provider",
      level,
      label: prov.provider,
      input: prov.input,
      output: prov.output,
      cacheWrite: prov.cacheWrite,
      cacheRead: prov.cacheRead,
      reasoning: prov.reasoning,
      cost: prov.cost,
      key: `provider:${provKey}`,
      expandKey: provKey,
      ...(prov.modelDetails.length > 0 ? { providerDetail: prov } : undefined),
    });
    if (provExpanded) {
      for (const mod of prov.modelDetails) {
        result.push({
          kind: "model",
          level: level + 1,
          label: mod.model,
          input: mod.input,
          output: mod.output,
          cacheWrite: mod.cacheWrite,
          cacheRead: mod.cacheRead,
          reasoning: mod.reasoning,
          cost: mod.cost,
          key: `model:${provKey}:${mod.model}`,
        });
      }
    }
  }
}

/**
 * Compute visible rows from parsed UsageRows and expand state.
 * Each row carries source-data refs so the renderer can use this as the
 * single source of truth for what to display.
 *
 * Visibility rules:
 *   - Day rows are always visible
 *   - Parent group / session rows visible when the day is expanded
 *   - Child sessions rendered recursively (arbitrary depth)
 *   - Provider rows visible when the parent session is expanded
 *   - Model rows visible when the provider is expanded
 *
 * Key conventions:
 *   - Day key: `day:{date}`
 *   - Parent group key: `parent_group:{date}:{sessionID}`
 *   - Session key: `session:{date}:{sessionID}`
 *   - Provider key: `provider:{baseKey}:{provider}`
 *   - Model key: `model:{baseKey}:{provider}:{model}`
 *   - Child session key: `child_session:{baseKey}:{sessionID}`
 */
export function computeVisibleRows(
  rows: UsageRow[],
  expansion: ExpansionState
): VisibleRow[] {
  const result: VisibleRow[] = [];

  for (const row of rows) {
    const dayExpanded = expansion.days.has(row.date);
    const hasChildren =
      row.sessionDetails.length > 0 || row.parentGroups.length > 0;

    result.push({
      kind: "day",
      level: 0,
      label: row.date,
      input: row.inputTokens,
      output: row.outputTokens,
      cacheWrite: row.cacheWrite,
      cacheRead: row.cacheRead,
      reasoning: row.reasoning,
      cost: row.cost,
      key: `day:${row.date}`,
      expandKey: row.date,
      ...(hasChildren ? { dayRow: row } : undefined),
    });

    if (!dayExpanded) continue;

    // Render parent groups first
    for (const pg of row.parentGroups) {
      const pgKey = `${row.date}:${pg.sessionID}`;

      // Flat classifications render as simple session rows (no group wrapper)
      if (pg.classification !== "parent") {
        const sesKey = pgKey;
        const sesExpanded = expansion.sessions.has(sesKey);
        const sesHasChildren =
          pg.totalProviderDetails.length > 0 || pg.children.length > 0;

        result.push({
          kind: "session",
          level: 1,
          label: pg.title,
          input: pg.totalInput,
          output: pg.totalOutput,
          cacheWrite: pg.totalCacheWrite,
          cacheRead: pg.totalCacheRead,
          reasoning: pg.totalReasoning,
          cost: pg.totalCost,
          key: `session:${sesKey}`,
          expandKey: sesKey,
          classification: pg.classification,
          ...(sesHasChildren ? { sessionDetail: pg.ownDetails } : undefined),
        });

        if (sesExpanded) {
          renderSessionProviders(
            pg.ownDetails,
            sesKey,
            2,
            expansion.providers,
            result
          );
        }
        continue;
      }

      // "parent" classification: expandable group → own_work → children
      const pgExpanded = expansion.parentGroups.has(pgKey);
      const pgHasChildren =
        pg.children.length > 0 ||
        pg.ownDetails.providerDetails.length > 0 ||
        pg.totalProviderDetails.length > 0;

      result.push({
        kind: "parent_group",
        level: 1,
        label: pg.title,
        input: pg.totalInput,
        output: pg.totalOutput,
        cacheWrite: pg.totalCacheWrite,
        cacheRead: pg.totalCacheRead,
        reasoning: pg.totalReasoning,
        cost: pg.totalCost,
        key: `parent_group:${pgKey}`,
        expandKey: pgKey,
        classification: pg.classification,
        ...(pgHasChildren ? { parentGroup: pg } : undefined),
      });

      if (!pgExpanded) continue;

      // "Own work" row — always rendered when parent group is expanded
      const ownKey = `${pgKey}:__own__`;
      const ownExpanded = expansion.sessions.has(ownKey);
      const ownHasProviders = pg.ownDetails.providerDetails.length > 0;

      result.push({
        kind: "own_work",
        level: 2,
        label: "Own work",
        input: pg.ownDetails.input,
        output: pg.ownDetails.output,
        cacheWrite: pg.ownDetails.cacheWrite,
        cacheRead: pg.ownDetails.cacheRead,
        reasoning: pg.ownDetails.reasoning,
        cost: pg.ownDetails.cost,
        key: `own_work:${ownKey}`,
        expandKey: ownKey,
        ...(ownHasProviders ? { sessionDetail: pg.ownDetails } : undefined),
      });

      if (ownExpanded) {
        renderSessionProviders(
          pg.ownDetails,
          ownKey,
          3,
          expansion.providers,
          result
        );
      }

      // Render totalProviderDetails when group is expanded (aggregate providers)
      if (pg.totalProviderDetails.length > 0) {
        const totalProvKey = `${pgKey}:__total__`;
        const totalProvExpanded = expansion.sessions.has(totalProvKey);
        result.push({
          kind: "own_work",
          level: 2,
          label: "All providers (total)",
          input: pg.totalProviderDetails.reduce((s, p) => s + p.input, 0),
          output: pg.totalProviderDetails.reduce((s, p) => s + p.output, 0),
          cacheWrite: pg.totalProviderDetails.reduce(
            (s, p) => s + p.cacheWrite,
            0
          ),
          cacheRead: pg.totalProviderDetails.reduce(
            (s, p) => s + p.cacheRead,
            0
          ),
          reasoning: pg.totalProviderDetails.reduce(
            (s, p) => s + p.reasoning,
            0
          ),
          cost: pg.totalProviderDetails.reduce((s, p) => s + p.cost, 0),
          key: `total_providers:${totalProvKey}`,
          expandKey: totalProvKey,
          sessionDetail: {
            sessionID: pg.sessionID,
            title: "All providers (total)",
            input: pg.totalProviderDetails.reduce((s, p) => s + p.input, 0),
            output: pg.totalProviderDetails.reduce((s, p) => s + p.output, 0),
            cacheWrite: pg.totalProviderDetails.reduce(
              (s, p) => s + p.cacheWrite,
              0
            ),
            cacheRead: pg.totalProviderDetails.reduce(
              (s, p) => s + p.cacheRead,
              0
            ),
            reasoning: pg.totalProviderDetails.reduce(
              (s, p) => s + p.reasoning,
              0
            ),
            cost: pg.totalProviderDetails.reduce((s, p) => s + p.cost, 0),
            providerDetails: pg.totalProviderDetails,
          },
        });

        if (totalProvExpanded) {
          renderSessionProviders(
            {
              sessionID: pg.sessionID,
              title: "All providers (total)",
              input: pg.totalProviderDetails.reduce((s, p) => s + p.input, 0),
              output: pg.totalProviderDetails.reduce((s, p) => s + p.output, 0),
              cacheWrite: pg.totalProviderDetails.reduce(
                (s, p) => s + p.cacheWrite,
                0
              ),
              cacheRead: pg.totalProviderDetails.reduce(
                (s, p) => s + p.cacheRead,
                0
              ),
              reasoning: pg.totalProviderDetails.reduce(
                (s, p) => s + p.reasoning,
                0
              ),
              cost: pg.totalProviderDetails.reduce((s, p) => s + p.cost, 0),
              providerDetails: pg.totalProviderDetails,
            },
            totalProvKey,
            3,
            expansion.providers,
            result
          );
        }
      }

      // Child sessions (recursive)
      for (const cs of pg.children) {
        renderChildSession(
          cs,
          pgKey,
          2,
          expansion.sessions,
          expansion.providers,
          result
        );
      }
    }

    // Standalone sessions (not in any parent group tree)
    const parentGroupSessionIds = new Set(
      row.parentGroups.flatMap((pg) => [
        pg.sessionID,
        ...collectDescendantSessionIds(pg.children),
      ])
    );
    for (const ses of row.sessionDetails) {
      if (parentGroupSessionIds.has(ses.sessionID)) continue;

      const sesKey = `${row.date}:${ses.sessionID}`;
      const sesExpanded = expansion.sessions.has(sesKey);
      const sesHasChildren = ses.providerDetails.length > 0;

      result.push({
        kind: "session",
        level: 1,
        label: ses.title,
        input: ses.input,
        output: ses.output,
        cacheWrite: ses.cacheWrite,
        cacheRead: ses.cacheRead,
        reasoning: ses.reasoning,
        cost: ses.cost,
        key: `session:${row.date}:${ses.sessionID}`,
        expandKey: sesKey,
        ...(sesHasChildren ? { sessionDetail: ses } : undefined),
      });

      if (sesExpanded) {
        renderSessionProviders(ses, sesKey, 2, expansion.providers, result);
      }
    }
  }

  return result;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatCompactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
