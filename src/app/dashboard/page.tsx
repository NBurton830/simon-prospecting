import { LogOut } from "lucide-react";
import { currentUserEmail, signOut } from "@/auth";
import { MetricsHeader } from "@/components/MetricsHeader";
import { ProspectTable } from "@/components/ProspectTable";
import { Button } from "@/components/ui/button";
import { isAuthDisabled } from "@/lib/auth-rules";
import { loadDashboard } from "@/lib/dashboard/queries";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [data, email] = await Promise.all([getDb().then((db) => loadDashboard(db, new Date())), currentUserEmail()]);

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Retail Brand Prospector</h1>
          <p className="text-sm text-muted-foreground">Emerging consumer brands showing signs of physical-retail expansion.</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {isAuthDisabled() ? (
            <span className="rounded-md bg-amber-100 px-2 py-1 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
              Dev mode: sign-in disabled
            </span>
          ) : (
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
              className="flex items-center gap-2"
            >
              <span>{email}</span>
              <Button variant="ghost" size="sm" type="submit">
                <LogOut className="size-3.5" aria-hidden /> Sign out
              </Button>
            </form>
          )}
        </div>
      </header>

      <MetricsHeader metrics={data.metrics} pipeline={data.pipeline} />
      <ProspectTable initialProspects={data.prospects} />
    </main>
  );
}
