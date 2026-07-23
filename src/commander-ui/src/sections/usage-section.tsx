import { useState, useMemo, useReducer, Fragment } from "react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  type UsageRow,
  type VisibleRow,
  type ExpansionState,
  type ExpansionAction,
  aggregateMonthly,
  computeVisibleRows,
  reduceExpansion,
  INITIAL_EXPANSION,
  formatNumber,
  formatCost,
} from "@/lib/data-utils";
import { RefreshCw, ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const PROVIDERS = ["all", "anthropic", "antigravity", "codex"] as const;

type UsageSectionProps = {
  dailyRows: UsageRow[];
  usageStatus: string;
  usageError: Error | null;
  onRefetch: () => void;
  filters: {
    provider: string;
    days: string;
    since: string;
    until: string;
  };
  onFilterChange: {
    setProvider: (v: string) => void;
    setDays: (v: string) => void;
    setSince: (v: string) => void;
    setUntil: (v: string) => void;
  };
};

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const INDENT_STEP = 16;
const MAX_INDENT = 6;
/** Left padding (px) for a given nesting level, clamped to MAX_INDENT */
function indentPx(level: number): number {
  return Math.min(level, MAX_INDENT) * INDENT_STEP;
}

// ---------------------------------------------------------------------------
// Shared expand toggle button (keyboard-accessible, aria-labeled, 24×24 min)
// ---------------------------------------------------------------------------

function ExpandToggle({
  expanded,
  label,
  kind,
  classification,
  onClick,
  className,
}: {
  expanded: boolean;
  label: string;
  kind?: string;
  classification?: string;
  onClick: () => void;
  className?: string;
}) {
  const kindLabel = kind
    ? ({
        day: "date",
        parent_group: "group",
        own_work: "own work",
        child_session: "child session",
        session: "session",
        provider: "provider",
      }[kind] ?? kind)
    : "";
  const classificationPrefix =
    classification === "orphan"
      ? "orphan "
      : classification === "unknown"
        ? "unknown "
        : "";
  const actionLabel = kindLabel
    ? `${expanded ? "Collapse" : "Expand"} ${classificationPrefix}${kindLabel}: ${label}`
    : `${expanded ? "Collapse" : "Expand"} ${classificationPrefix}${label}`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-label={actionLabel}
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        "size-6 min-h-6 min-w-6",
        "bg-transparent border-0 outline-none cursor-pointer",
        "text-inherit hover:bg-accent/30",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        "rounded-sm transition-colors",
        className
      )}
    >
      {expanded ? (
        <ChevronDown className="size-3 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3 text-muted-foreground" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Placeholder spacer for leaf rows (same 24×24 size, non-interactive)
// ---------------------------------------------------------------------------

function LeafSpacer() {
  return (
    <span className="size-6 min-h-6 min-w-6 inline-flex items-center justify-center shrink-0" />
  );
}

// ---------------------------------------------------------------------------
// Shared metric cells (reused by every row level)
// ---------------------------------------------------------------------------

function MetricCells({
  input,
  output,
  cacheWrite,
  cacheRead,
  reasoning,
  total,
  cost,
  muted,
  subtle,
}: {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  total: number;
  cost: number;
  muted?: boolean;
  subtle?: boolean;
}) {
  const cls = subtle
    ? "text-[10px] text-muted-foreground/80"
    : muted
      ? "text-[11px] text-muted-foreground"
      : "";
  const mono = subtle ? "text-[10px]" : muted ? "text-[11px]" : "";
  return (
    <>
      <TableCell className={cn("text-right font-mono tabular-nums", cls)}>
        {formatNumber(input)}
      </TableCell>
      <TableCell className={cn("text-right font-mono tabular-nums", cls)}>
        {formatNumber(output)}
      </TableCell>
      <TableCell className={cn("text-right font-mono tabular-nums", cls)}>
        {formatNumber(cacheWrite)}
      </TableCell>
      <TableCell className={cn("text-right font-mono tabular-nums", cls)}>
        {formatNumber(cacheRead)}
      </TableCell>
      <TableCell className={cn("text-right font-mono tabular-nums", cls)}>
        {formatNumber(reasoning)}
      </TableCell>
      <TableCell
        className={cn("text-right font-mono tabular-nums font-medium", mono)}
      >
        {formatNumber(total)}
      </TableCell>
      <TableCell className={cn("text-right font-mono tabular-nums", cls)}>
        {formatCost(cost)}
      </TableCell>
    </>
  );
}

// ---------------------------------------------------------------------------
// Unified row renderer — driven entirely by computeVisibleRows output
// ---------------------------------------------------------------------------

function renderRow(
  row: VisibleRow,
  dispatch: (a: ExpansionAction) => void,
  expansion: ExpansionState
) {
  switch (row.kind) {
    // --- Day row -----------------------------------------------------------
    case "day": {
      const expanded = expansion.days.has(row.expandKey ?? "");
      const hasChildren = row.dayRow !== undefined;
      const dayTotal = row.input + row.output;
      return (
        <TableRow className={cn(hasChildren && expanded && "bg-accent/50")}>
          <TableCell className="p-0">
            {hasChildren ? (
              <div
                className="flex items-center"
                style={{ paddingLeft: indentPx(0) }}
              >
                <ExpandToggle
                  expanded={expanded}
                  label={row.label}
                  kind="day"
                  onClick={() =>
                    dispatch({ type: "TOGGLE_DAY", date: row.expandKey! })
                  }
                />
                <span className="font-mono text-xs">{row.label}</span>
              </div>
            ) : (
              <span className="px-3 py-2 font-mono text-xs inline-flex items-center gap-1">
                {row.label}
              </span>
            )}
          </TableCell>
          <TableCell />
          <MetricCells
            input={row.input}
            output={row.output}
            cacheWrite={row.cacheWrite}
            cacheRead={row.cacheRead}
            reasoning={row.reasoning}
            total={dayTotal}
            cost={row.cost}
          />
        </TableRow>
      );
    }

    // --- Session row -------------------------------------------------------
    case "session": {
      const hasChildren = row.sessionDetail !== undefined;
      const expanded = row.expandKey
        ? expansion.sessions.has(row.expandKey)
        : false;
      const total = row.input + row.output;
      return (
        <TableRow className="bg-muted/15 hover:bg-muted/25">
          <TableCell className="p-0">
            <div
              className="flex items-center"
              style={{ paddingLeft: indentPx(row.level) }}
            >
              {hasChildren && row.expandKey ? (
                <ExpandToggle
                  expanded={expanded}
                  label={row.label}
                  kind="session"
                  classification={row.classification}
                  onClick={() =>
                    dispatch({
                      type: "TOGGLE_SESSION",
                      sessionKey: row.expandKey!,
                    })
                  }
                />
              ) : (
                <LeafSpacer />
              )}
            </div>
          </TableCell>
          <TableCell style={{ paddingLeft: indentPx(row.level) + 4 }}>
            <span className="text-[11px] text-muted-foreground max-w-64 truncate block">
              {row.label}
            </span>
          </TableCell>
          <MetricCells
            input={row.input}
            output={row.output}
            cacheWrite={row.cacheWrite}
            cacheRead={row.cacheRead}
            reasoning={row.reasoning}
            total={total}
            cost={row.cost}
            muted
          />
        </TableRow>
      );
    }

    // --- Parent group row --------------------------------------------------
    case "parent_group": {
      const hasChildren =
        row.parentGroup !== undefined &&
        (row.parentGroup.children.length > 0 ||
          row.parentGroup.ownDetails.providerDetails.length > 0 ||
          row.parentGroup.totalProviderDetails.length > 0);
      const expanded = row.expandKey
        ? expansion.parentGroups.has(row.expandKey)
        : false;
      const total = row.input + row.output;
      return (
        <TableRow className="bg-muted/15 hover:bg-muted/25">
          <TableCell className="p-0">
            <div
              className="flex items-center"
              style={{ paddingLeft: indentPx(row.level) }}
            >
              {hasChildren && row.expandKey ? (
                <ExpandToggle
                  expanded={expanded}
                  label={row.label}
                  kind="parent_group"
                  classification={row.classification}
                  onClick={() =>
                    dispatch({
                      type: "TOGGLE_PARENT_GROUP",
                      groupKey: row.expandKey!,
                    })
                  }
                />
              ) : (
                <LeafSpacer />
              )}
            </div>
          </TableCell>
          <TableCell style={{ paddingLeft: indentPx(row.level) + 4 }}>
            <span className="text-[11px] text-muted-foreground max-w-64 truncate block">
              {row.label}
            </span>
          </TableCell>
          <MetricCells
            input={row.input}
            output={row.output}
            cacheWrite={row.cacheWrite}
            cacheRead={row.cacheRead}
            reasoning={row.reasoning}
            total={total}
            cost={row.cost}
            muted
          />
        </TableRow>
      );
    }

    // --- Own work row (parent group's own session) -------------------------
    case "own_work": {
      const hasChildren = row.sessionDetail !== undefined;
      const expanded = row.expandKey
        ? expansion.sessions.has(row.expandKey)
        : false;
      const total = row.input + row.output;
      return (
        <TableRow className="bg-muted/20 hover:bg-muted/30">
          <TableCell className="p-0">
            <div
              className="flex items-center"
              style={{ paddingLeft: indentPx(row.level) }}
            >
              {hasChildren && row.expandKey ? (
                <ExpandToggle
                  expanded={expanded}
                  label={row.label}
                  kind="own_work"
                  onClick={() =>
                    dispatch({
                      type: "TOGGLE_SESSION",
                      sessionKey: row.expandKey!,
                    })
                  }
                />
              ) : (
                <LeafSpacer />
              )}
            </div>
          </TableCell>
          <TableCell style={{ paddingLeft: indentPx(row.level) + 4 }}>
            <span className="text-[11px] text-muted-foreground max-w-64 truncate block italic">
              {row.label}
            </span>
          </TableCell>
          <MetricCells
            input={row.input}
            output={row.output}
            cacheWrite={row.cacheWrite}
            cacheRead={row.cacheRead}
            reasoning={row.reasoning}
            total={total}
            cost={row.cost}
            muted
          />
        </TableRow>
      );
    }

    // --- Child session row -------------------------------------------------
    case "child_session": {
      const hasChildren = row.sessionDetail !== undefined;
      const expanded = row.expandKey
        ? expansion.sessions.has(row.expandKey)
        : false;
      const total = row.input + row.output;
      return (
        <TableRow className="bg-muted/20 hover:bg-muted/30">
          <TableCell className="p-0">
            <div
              className="flex items-center"
              style={{ paddingLeft: indentPx(row.level) }}
            >
              {hasChildren && row.expandKey ? (
                <ExpandToggle
                  expanded={expanded}
                  label={row.label}
                  kind="child_session"
                  onClick={() =>
                    dispatch({
                      type: "TOGGLE_SESSION",
                      sessionKey: row.expandKey!,
                    })
                  }
                />
              ) : (
                <LeafSpacer />
              )}
            </div>
          </TableCell>
          <TableCell style={{ paddingLeft: indentPx(row.level) + 4 }}>
            <span className="text-[11px] text-muted-foreground max-w-64 truncate block">
              {row.label}
            </span>
          </TableCell>
          <MetricCells
            input={row.input}
            output={row.output}
            cacheWrite={row.cacheWrite}
            cacheRead={row.cacheRead}
            reasoning={row.reasoning}
            total={total}
            cost={row.cost}
            muted
          />
        </TableRow>
      );
    }

    // --- Provider row ------------------------------------------------------
    case "provider": {
      const hasChildren = row.providerDetail !== undefined;
      const expanded = row.expandKey
        ? expansion.providers.has(row.expandKey)
        : false;
      const total = row.input + row.output;
      return (
        <TableRow className="bg-muted/20 hover:bg-muted/30">
          <TableCell className="p-0">
            <div
              className="flex items-center"
              style={{ paddingLeft: indentPx(row.level) }}
            >
              {hasChildren && row.expandKey ? (
                <ExpandToggle
                  expanded={expanded}
                  label={row.label}
                  kind="provider"
                  onClick={() =>
                    dispatch({
                      type: "TOGGLE_PROVIDER",
                      providerKey: row.expandKey!,
                    })
                  }
                />
              ) : (
                <LeafSpacer />
              )}
            </div>
          </TableCell>
          <TableCell style={{ paddingLeft: indentPx(row.level) + 4 }}>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              [{row.label}]
            </span>
          </TableCell>
          <MetricCells
            input={row.input}
            output={row.output}
            cacheWrite={row.cacheWrite}
            cacheRead={row.cacheRead}
            reasoning={row.reasoning}
            total={total}
            cost={row.cost}
            muted
          />
        </TableRow>
      );
    }

    // --- Model row (leaf — never expandable) -------------------------------
    case "model": {
      const total = row.input + row.output;
      return (
        <TableRow className="bg-muted/10 hover:bg-muted/20">
          <TableCell />
          <TableCell style={{ paddingLeft: indentPx(row.level) }}>
            <span className="font-mono text-[10px] text-muted-foreground/80">
              {row.label}
            </span>
          </TableCell>
          <MetricCells
            input={row.input}
            output={row.output}
            cacheWrite={row.cacheWrite}
            cacheRead={row.cacheRead}
            reasoning={row.reasoning}
            total={total}
            cost={row.cost}
            subtle
          />
        </TableRow>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main usage table — consumes computeVisibleRows as the single source of truth
// ---------------------------------------------------------------------------

function UsageTable({ rows }: { rows: UsageRow[] }) {
  const [expansion, dispatch] = useReducer(reduceExpansion, INITIAL_EXPANSION);

  // Compute visible rows from the shared pure model
  const visible = useMemo(
    () => computeVisibleRows(rows, expansion),
    [rows, expansion]
  );

  // --- Totals ---
  const totals = useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheWrite = 0;
    let cacheRead = 0;
    let reasoning = 0;
    let cost = 0;
    for (const r of rows) {
      input += r.inputTokens;
      output += r.outputTokens;
      cacheWrite += r.cacheWrite;
      cacheRead += r.cacheRead;
      reasoning += r.reasoning;
      cost += r.cost;
    }
    return {
      input,
      output,
      cacheWrite,
      cacheRead,
      reasoning,
      total: input + output,
      cost,
    };
  }, [rows]);

  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs py-4">No usage data</p>;
  }

  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">Label</TableHead>
            <TableHead className="w-[180px]" />
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
            <TableHead className="text-right">Cache W</TableHead>
            <TableHead className="text-right">Cache R</TableHead>
            <TableHead className="text-right">Reasoning</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <Fragment key={row.key}>
              {renderRow(row, dispatch, expansion)}
            </Fragment>
          ))}

          {/* --- Summary total --- */}
          <TableRow className="border-t-2 border-border bg-muted/30">
            <TableCell colSpan={2} className="font-mono font-semibold">
              Total
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.input)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.output)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.cacheWrite)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.cacheRead)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.reasoning)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.total)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatCost(totals.cost)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monthly table (summary-only, no drilldown)
// ---------------------------------------------------------------------------

function MonthlyTable({ rows }: { rows: UsageRow[] }) {
  const totals = useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheWrite = 0;
    let cacheRead = 0;
    let reasoning = 0;
    let cost = 0;
    for (const r of rows) {
      input += r.inputTokens;
      output += r.outputTokens;
      cacheWrite += r.cacheWrite;
      cacheRead += r.cacheRead;
      reasoning += r.reasoning;
      cost += r.cost;
    }
    return {
      input,
      output,
      cacheWrite,
      cacheRead,
      reasoning,
      total: input + output,
      cost,
    };
  }, [rows]);

  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs py-4">No usage data</p>;
  }

  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">Month</TableHead>
            <TableHead className="w-[180px]" />
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
            <TableHead className="text-right">Cache W</TableHead>
            <TableHead className="text-right">Cache R</TableHead>
            <TableHead className="text-right">Reasoning</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const rowTotal = row.inputTokens + row.outputTokens;
            return (
              <TableRow key={row.date}>
                <TableCell className="font-mono text-xs">{row.date}</TableCell>
                <TableCell />
                <MetricCells
                  input={row.inputTokens}
                  output={row.outputTokens}
                  cacheWrite={row.cacheWrite}
                  cacheRead={row.cacheRead}
                  reasoning={row.reasoning}
                  total={rowTotal}
                  cost={row.cost}
                />
              </TableRow>
            );
          })}
          <TableRow className="border-t-2 border-border bg-muted/30">
            <TableCell colSpan={2} className="font-mono font-semibold">
              Total
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.input)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.output)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.cacheWrite)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.cacheRead)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.reasoning)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatNumber(totals.total)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums font-semibold">
              {formatCost(totals.cost)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

export function UsageSection({
  dailyRows,
  usageStatus,
  usageError,
  onRefetch,
  filters,
  onFilterChange,
}: UsageSectionProps) {
  const [view, setView] = useState<"daily" | "monthly">("daily");
  const monthlyRows = useMemo(() => aggregateMonthly(dailyRows), [dailyRows]);
  const rows = view === "daily" ? dailyRows : monthlyRows;

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
          ■ Usage Breakdown
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefetch}
          className="size-7 p-0"
        >
          <RefreshCw className="size-3" />
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground leading-none">
            Provider
          </label>
          <Select
            value={filters.provider}
            onValueChange={(v) => v && onFilterChange.setProvider(v)}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p === "all" ? "All Providers" : p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground leading-none">
            Days
          </label>
          <Input
            type="number"
            value={filters.days}
            onChange={(e) => onFilterChange.setDays(e.target.value)}
            className="w-20 tabular-nums"
            min={1}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground leading-none">
            Since
          </label>
          <Input
            type="date"
            value={filters.since}
            onChange={(e) => onFilterChange.setSince(e.target.value)}
            className="w-36"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground leading-none">
            Until
          </label>
          <Input
            type="date"
            value={filters.until}
            onChange={(e) => onFilterChange.setUntil(e.target.value)}
            className="w-36"
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex gap-px">
            <Button
              variant={view === "daily" ? "default" : "outline"}
              size="sm"
              onClick={() => setView("daily")}
            >
              Daily
            </Button>
            <Button
              variant={view === "monthly" ? "default" : "outline"}
              size="sm"
              onClick={() => setView("monthly")}
            >
              Monthly
            </Button>
          </div>
        </div>
      </div>

      {/* Usage table */}
      {usageStatus === "loading" && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead />
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">Cache W</TableHead>
              <TableHead className="text-right">Cache R</TableHead>
              <TableHead className="text-right">Reasoning</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[1, 2, 3, 4, 5].map((k) => (
              <TableRow key={k}>
                <TableCell colSpan={2}>
                  <Skeleton className="h-3.5 w-32" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-3.5 w-16" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-3.5 w-16" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-3.5 w-14" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-3.5 w-14" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-3.5 w-14" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-3.5 w-16" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-3.5 w-14" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {usageStatus === "error" && usageError && (
        <Card>
          <CardContent className="py-3 flex items-center justify-between">
            <p className="text-destructive text-xs">
              Failed to load usage: {usageError.message}
            </p>
            <Button variant="outline" size="sm" onClick={onRefetch}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {usageStatus === "success" &&
        (view === "daily" ? (
          <UsageTable rows={rows} />
        ) : (
          <MonthlyTable rows={rows} />
        ))}
    </div>
  );
}
