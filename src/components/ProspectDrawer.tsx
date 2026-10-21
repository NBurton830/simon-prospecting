"use client";

import { useEffect, useState } from "react";
import { Briefcase, Check, Copy, ExternalLink, FileText } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ScoreBadge } from "@/components/ScoreBadge";
import { getProspectSignals } from "@/app/dashboard/actions";
import { PROSPECT_STATUSES, type ProspectStatus } from "@/config/taxonomy";
import { formatDate, formatUsd, STATUS_LABELS } from "@/lib/dashboard/format";
import type { ProspectRow, SignalDetail } from "@/lib/dashboard/queries";

const BREAKDOWN: { key: keyof ProspectRow["scoreBreakdown"]; label: string; max: number }[] = [
  { key: "funding", label: "Funding", max: 30 },
  { key: "retail_hiring", label: "Retail hiring", max: 30 },
  { key: "physical_stage", label: "Physical stage", max: 20 },
  { key: "category_fit", label: "Category fit", max: 10 },
  { key: "recency", label: "Recency", max: 10 },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function SignalItem({ s }: { s: SignalDetail }) {
  const [expanded, setExpanded] = useState(false);
  if (s.type === "SEC_FORM_D") {
    return (
      <li className="space-y-1 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-medium">
            <FileText className="size-4 text-muted-foreground" aria-hidden /> SEC Form D
          </span>
          <span className="text-xs text-muted-foreground">{formatDate(s.date)}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Offering {s.offering?.total === null ? "Indefinite" : formatUsd(s.offering?.total ?? null)} · Sold{" "}
          {formatUsd(s.offering?.sold ?? null)}
          {s.offering?.industryGroup ? ` · ${s.offering.industryGroup}` : ""}
        </p>
        <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
          View filing on EDGAR <ExternalLink className="size-3" aria-hidden />
        </a>
      </li>
    );
  }
  return (
    <li className="space-y-1 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          <Briefcase className="size-4 text-muted-foreground" aria-hidden /> {s.title ?? "Job listing"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatDate(s.date)}</span>
      </div>
      {s.location && <p className="text-sm text-muted-foreground">{s.location}</p>}
      {s.description && (
        <div className="text-sm">
          <p className={expanded ? "whitespace-pre-line" : "line-clamp-3"}>{s.description}</p>
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : "Show full description"}
          </button>
        </div>
      )}
      {s.url && (
        <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
          Open listing <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </li>
  );
}

export function ProspectDrawer({
  prospect,
  onClose,
  onStatusChange,
}: {
  prospect: ProspectRow | null;
  onClose: () => void;
  onStatusChange: (id: string, status: ProspectStatus) => void;
}) {
  const [signals, setSignals] = useState<{ id: string; items: SignalDetail[] } | null>(null);
  const [signalsError, setSignalsError] = useState(false);
  const [copied, setCopied] = useState(false);
  const prospectId = prospect?.id;

  useEffect(() => {
    if (!prospectId) return;
    let cancelled = false;
    setSignalsError(false);
    getProspectSignals(prospectId)
      .then((items) => !cancelled && setSignals({ id: prospectId, items }))
      .catch(() => !cancelled && setSignalsError(true));
    return () => {
      cancelled = true;
    };
  }, [prospectId]);

  async function copyPitch() {
    if (!prospect) return;
    try {
      await navigator.clipboard.writeText(prospect.pitchAngle);
      setCopied(true);
      toast.success("Pitch copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select the text and copy it manually");
    }
  }

  const loadedSignals = signals && signals.id === prospectId ? signals.items : null;

  return (
    <Sheet open={prospect !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        {prospect && (
          <>
            <SheetHeader className="gap-2 border-b pb-4">
              <div className="flex items-start gap-3 pr-8">
                <ScoreBadge score={prospect.readinessScore} className="mt-0.5 text-base" />
                <div className="min-w-0 space-y-1">
                  <SheetTitle className="text-lg">{prospect.brandName}</SheetTitle>
                  <SheetDescription>
                    {prospect.domain ? (
                      <a href={`https://${prospect.domain}`} target="_blank" rel="noreferrer" className="hover:underline">
                        {prospect.domain}
                      </a>
                    ) : (
                      "Domain unknown"
                    )}
                    {prospect.hqState ? ` · ${prospect.hqState}` : ""}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {prospect.category && <Badge variant="secondary">{prospect.category}</Badge>}
                <Badge variant="outline">{prospect.expansionStage}</Badge>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Status</span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  value={prospect.status}
                  onChange={(e) => onStatusChange(prospect.id, e.target.value as ProspectStatus)}
                >
                  {PROSPECT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
            </SheetHeader>

            <div className="space-y-6 px-4 pb-8">
              <Section title="Pitch">
                <blockquote className="rounded-md border-l-2 border-primary bg-muted/50 p-3 text-sm leading-relaxed">
                  {prospect.pitchAngle}
                </blockquote>
                <Button size="sm" onClick={copyPitch}>
                  {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                  {copied ? "Copied" : "Copy pitch"}
                </Button>
              </Section>

              <Section title="Recommended formats">
                <div className="flex flex-wrap gap-1.5">
                  {prospect.recommendedFormats.map((f) => (
                    <Badge key={f} variant="outline">
                      {f}
                    </Badge>
                  ))}
                </div>
              </Section>

              <Section title="Readiness score">
                <dl className="space-y-1.5">
                  {BREAKDOWN.map(({ key, label, max }) => {
                    const value = prospect.scoreBreakdown[key];
                    return (
                      <div key={key} className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-2 text-sm">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <div className="h-full rounded-full bg-primary" style={{ width: `${(value / max) * 100}%` }} />
                        </dd>
                        <dd className="text-right tabular-nums">
                          {value}/{max}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                <p className="text-sm leading-relaxed text-muted-foreground">{prospect.scoreRationale}</p>
              </Section>

              <Section title="About">
                {prospect.description && <p className="text-sm">{prospect.description}</p>}
                <dl className="grid grid-cols-[7.5rem_1fr] gap-x-2 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Funding</dt>
                  <dd>{prospect.fundingSummary}</dd>
                  <dt className="text-muted-foreground">Audience</dt>
                  <dd>{prospect.targetDemographics}</dd>
                  {prospect.keyHiringRoles.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">Hiring</dt>
                      <dd>{prospect.keyHiringRoles.join("; ")}</dd>
                    </>
                  )}
                </dl>
              </Section>

              {prospect.keyPeople.length > 0 && (
                <Section title="Key people (from SEC filing)">
                  <ul className="space-y-1 text-sm">
                    {prospect.keyPeople.map((p) => (
                      <li key={`${p.name}-${p.relationship}`}>
                        {p.name} <span className="text-muted-foreground">— {p.relationship}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Separator />

              <Section title="Signals">
                {signalsError ? (
                  <p className="text-sm text-destructive">Couldn&apos;t load signals. Close and reopen to try again.</p>
                ) : loadedSignals === null ? (
                  <div className="space-y-2">
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-20 w-full" />
                  </div>
                ) : loadedSignals.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No analyzed signals.</p>
                ) : (
                  <ul className="space-y-2">
                    {loadedSignals.map((s) => (
                      <SignalItem key={s.id} s={s} />
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
