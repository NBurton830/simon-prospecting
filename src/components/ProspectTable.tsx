"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProspectDrawer } from "@/components/ProspectDrawer";
import { ProspectFilters } from "@/components/ProspectFilters";
import { ScoreBadge } from "@/components/ScoreBadge";
import { updateProspectStatus } from "@/app/dashboard/actions";
import type { ProspectStatus } from "@/config/taxonomy";
import {
  categoriesIn,
  DEFAULT_FILTERS,
  filterProspects,
  sortProspects,
  type ProspectFilters as Filters,
  type SortDir,
  type SortKey,
} from "@/lib/dashboard/filter";
import { formatDate, STATUS_LABELS } from "@/lib/dashboard/format";
import type { ProspectRow } from "@/lib/dashboard/queries";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<ProspectStatus, string> = {
  NEW: "border-transparent bg-primary/10 text-primary",
  REVIEWED: "border-transparent bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  CONTACTED: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  ARCHIVED: "border-transparent bg-muted text-muted-foreground",
};

function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === column;
  const Icon = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(column)} className="inline-flex items-center gap-1 font-medium hover:text-foreground">
        {label}
        <Icon className={cn("size-3.5", active ? "opacity-100" : "opacity-0")} aria-hidden />
      </button>
    </TableHead>
  );
}

export function ProspectTable({ initialProspects }: { initialProspects: ProspectRow[] }) {
  const [rows, setRows] = useState(initialProspects);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "score", dir: "desc" });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const categories = useMemo(() => categoriesIn(rows), [rows]);
  const visible = useMemo(() => sortProspects(filterProspects(rows, filters), sort.key, sort.dir), [rows, filters, sort]);
  const selected = rows.find((p) => p.id === selectedId) ?? null;

  function onSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }

  async function changeStatus(id: string, status: ProspectStatus) {
    const previous = rows;
    setRows((rs) => rs.map((p) => (p.id === id ? { ...p, status, hasNewActivity: false } : p)));
    try {
      await updateProspectStatus(id, status);
      toast.success(`Marked ${STATUS_LABELS[status].toLowerCase()}`);
    } catch {
      setRows(previous);
      toast.error("Couldn't update the status. Try again.");
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="font-medium">No prospects yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Prospects appear after the daily pipeline analyzes new signals. To run it now: <code className="rounded bg-muted px-1">npm run pipeline</code>
        </p>
      </div>
    );
  }

  return (
    <section className="space-y-4" aria-label="Prospects">
      <ProspectFilters filters={filters} onChange={setFilters} categories={categories} shown={visible.length} total={rows.length} />

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <SortHeader label="Brand" column="name" sort={sort} onSort={onSort} />
              <TableHead className="hidden md:table-cell">Category</TableHead>
              <SortHeader label="Score" column="score" sort={sort} onSort={onSort} />
              <TableHead className="hidden lg:table-cell">Recent signal</TableHead>
              <SortHeader label="Last signal" column="lastSignal" sort={sort} onSort={onSort} className="hidden sm:table-cell" />
              <TableHead className="hidden xl:table-cell">Top format</TableHead>
              <TableHead className="hidden sm:table-cell">Status</TableHead>
              <TableHead className="w-8">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((p) => (
              <TableRow key={p.id} className="cursor-pointer" onClick={() => setSelectedId(p.id)}>
                <TableCell className="max-w-56">
                  <div className="flex items-center gap-2">
                    {p.hasNewActivity && <span className="size-2 shrink-0 rounded-full bg-primary" title="New activity since last status change" />}
                    <button
                      type="button"
                      className="truncate text-left font-medium hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedId(p.id);
                      }}
                    >
                      {p.brandName}
                    </button>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{p.domain ?? p.hqState ?? ""}</p>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {p.category ? <Badge variant="secondary">{p.category}</Badge> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <ScoreBadge score={p.readinessScore} />
                </TableCell>
                <TableCell className="hidden max-w-72 truncate text-sm lg:table-cell">{p.recentSignalSummary}</TableCell>
                <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{formatDate(p.lastSignalAt)}</TableCell>
                <TableCell className="hidden text-sm xl:table-cell">{p.recommendedFormats[0] ?? "—"}</TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge className={STATUS_STYLES[p.status]}>{STATUS_LABELS[p.status]}</Badge>
                </TableCell>
                <TableCell>
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                </TableCell>
              </TableRow>
            ))}
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No prospects match these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <ProspectDrawer prospect={selected} onClose={() => setSelectedId(null)} onStatusChange={changeStatus} />
    </section>
  );
}
