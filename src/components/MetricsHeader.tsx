import { AlertTriangle, Activity } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { DashboardMetrics, PipelineStatus } from "@/lib/dashboard/queries";
import { describeAnalyzeRun, describeSyncRun, formatDateTimeUtc } from "@/lib/dashboard/format";

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card size="sm">
      <CardContent className="space-y-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className="truncate text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

export function MetricsHeader({ metrics, pipeline }: { metrics: DashboardMetrics; pipeline: PipelineStatus }) {
  const lastRun = pipeline.lastAnalyze ?? pipeline.lastSync;
  const problem =
    pipeline.lastAnalyze?.status === "FAILED" ||
    pipeline.lastAnalyze?.status === "PARTIAL" ||
    pipeline.lastSync?.status === "FAILED" ||
    pipeline.lastSync?.status === "PARTIAL";

  return (
    <section className="space-y-3" aria-label="Key metrics">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="High-intent prospects" value={String(metrics.highIntent)} hint="Score 80 or higher" />
        <Metric label="Signals ingested" value={String(metrics.signals7d)} hint="Last 7 days" />
        <Metric label="Top expanding category" value={metrics.topCategory ?? "—"} hint="Most prospects, last 30 days" />
        <Metric label="Average readiness" value={metrics.avgScore === null ? "—" : String(metrics.avgScore)} hint="Excluding archived" />
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {problem ? (
          <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
        ) : (
          <Activity className="size-3.5" aria-hidden />
        )}
        <span>{lastRun ? `Last run ${formatDateTimeUtc(lastRun.startedAt)}` : "Pipeline hasn't run yet"}</span>
        <span aria-hidden>·</span>
        <span>{describeSyncRun(pipeline.lastSync)}</span>
        <span aria-hidden>·</span>
        <span>{describeAnalyzeRun(pipeline.lastAnalyze)}</span>
        {pipeline.failedSignals > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="text-amber-700 dark:text-amber-400">{pipeline.failedSignals} failed signals</span>
          </>
        )}
      </p>
    </section>
  );
}
