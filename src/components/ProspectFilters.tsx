"use client";

import { ChevronDown, RotateCcw, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { PROSPECT_STATUSES, type ProspectStatus } from "@/config/taxonomy";
import { DEFAULT_FILTERS, type ProspectFilters as Filters } from "@/lib/dashboard/filter";
import { STATUS_LABELS } from "@/lib/dashboard/format";
import { cn } from "@/lib/utils";

const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

function summary(selected: string[], all: number, noun: string) {
  if (selected.length === 0 || selected.length === all) return `All ${noun}`;
  if (selected.length === 1) return selected[0];
  return `${selected.length} ${noun}`;
}

export function ProspectFilters({
  filters,
  onChange,
  categories,
  shown,
  total,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  categories: string[];
  shown: number;
  total: number;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const isDefault = JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS);

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
      <div className="relative lg:w-72">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Search brands, roles, pitches"
          className="pl-8"
          aria-label="Search prospects"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            {summary(filters.categories, categories.length, "categories")}
            <ChevronDown className="size-3.5 opacity-60" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {categories.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No categories yet</p>}
            {categories.map((c) => (
              <DropdownMenuCheckboxItem
                key={c}
                checked={filters.categories.includes(c)}
                onCheckedChange={() => set({ categories: toggle(filters.categories, c) })}
                closeOnClick={false}
              >
                {c}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            {summary(filters.statuses.map((s) => STATUS_LABELS[s]), PROSPECT_STATUSES.length, "statuses")}
            <ChevronDown className="size-3.5 opacity-60" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {PROSPECT_STATUSES.map((s: ProspectStatus) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={filters.statuses.includes(s)}
                onCheckedChange={() => set({ statuses: toggle(filters.statuses, s) })}
                closeOnClick={false}
              >
                {STATUS_LABELS[s]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant={filters.newOnly ? "secondary" : "outline"}
          size="sm"
          aria-pressed={filters.newOnly}
          onClick={() => set({ newOnly: !filters.newOnly })}
        >
          <Sparkles className={cn("size-3.5", filters.newOnly ? "text-primary" : "opacity-60")} aria-hidden />
          New activity
        </Button>

        <label className="flex items-center gap-3 rounded-md border px-3 py-1.5 text-sm">
          <span className="whitespace-nowrap text-muted-foreground">
            Min score <span className="font-medium text-foreground tabular-nums">{filters.minScore}</span>
          </span>
          <Slider
            className="w-28 shrink-0 data-[orientation=horizontal]:w-28"
            min={1}
            max={100}
            value={[filters.minScore]}
            onValueChange={(v) => set({ minScore: Array.isArray(v) ? (v[0] as number) : (v as number) })}
            aria-label="Minimum readiness score"
          />
        </label>

        {!isDefault && (
          <Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_FILTERS)}>
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </Button>
        )}
      </div>

      <p className="text-sm text-muted-foreground lg:ml-auto" aria-live="polite">
        {shown === total ? `${total} prospects` : `${shown} of ${total} prospects`}
      </p>
    </div>
  );
}
