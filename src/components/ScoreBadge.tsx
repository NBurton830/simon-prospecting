import { cn } from "@/lib/utils";
import { scoreTone } from "@/lib/dashboard/format";

const TONE_CLASSES = {
  high: "bg-emerald-100 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30",
  mid: "bg-amber-100 text-amber-800 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/30",
  low: "bg-muted text-muted-foreground ring-border",
} as const;

export function ScoreBadge({ score, className }: { score: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-10 items-center justify-center rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums ring-1 ring-inset",
        TONE_CLASSES[scoreTone(score)],
        className,
      )}
      aria-label={`Readiness score ${score} out of 100`}
    >
      {score}
    </span>
  );
}
