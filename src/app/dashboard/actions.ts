"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentUserEmail } from "@/auth";
import { PROSPECT_STATUSES } from "@/config/taxonomy";
import { loadProspectSignals, setProspectStatus, type SignalDetail } from "@/lib/dashboard/queries";
import { getDb } from "@/lib/db";

const StatusInput = z.object({ prospectId: z.uuid(), status: z.enum(PROSPECT_STATUSES) });

async function requireUser(): Promise<string> {
  const email = await currentUserEmail();
  if (!email) throw new Error("Not signed in");
  return email;
}

export async function updateProspectStatus(prospectId: string, status: string) {
  const email = await requireUser();
  const input = StatusInput.parse({ prospectId, status });
  const result = await setProspectStatus(await getDb(), input.prospectId, input.status, email);
  if (!result) throw new Error("Prospect not found");
  revalidatePath("/dashboard");
  return result;
}

export async function getProspectSignals(prospectId: string): Promise<SignalDetail[]> {
  await requireUser();
  return loadProspectSignals(await getDb(), z.uuid().parse(prospectId));
}
