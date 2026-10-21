import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { runRetention } from "@/lib/pipeline/retention";
import { createTestDb, type TestDb } from "../helpers/db";
import { makeBrand, makeSignal, signalsOf } from "../helpers/factories";

const TODAY = "2026-10-21";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => t.reset());
afterAll(async () => t.close());

const jobPayload = { jobId: "j", employerName: "Fernwood Skin Co", title: "Director of Retail", description: "long text" };

describe("runRetention", () => {
  test("strips job descriptions older than 180 days and keeps the rest of the payload", async () => {
    const b = await makeBrand(t.db);
    await makeSignal(t.db, b.id, { signalDate: "2026-04-23", rawPayload: jobPayload }); // 181 days
    await makeSignal(t.db, b.id, { signalDate: "2026-04-24", rawPayload: jobPayload }); // 180 days

    const result = await runRetention(t.db, TODAY);
    expect(result.descriptionsStripped).toBe(1);
    const [old, recent] = await signalsOf(t.db, b.id);
    expect(old.rawPayload).toEqual({ jobId: "j", employerName: "Fernwood Skin Co", title: "Director of Retail" });
    expect(recent.rawPayload).toEqual(jobPayload);
  });

  test("never touches Form D payloads", async () => {
    const b = await makeBrand(t.db);
    const payload = { issuerName: "hiyo Inc.", description: "not a job field" };
    await makeSignal(t.db, b.id, { signalType: "SEC_FORM_D", signalDate: "2025-01-01", rawPayload: payload });
    await runRetention(t.db, TODAY);
    expect((await signalsOf(t.db, b.id))[0].rawPayload).toEqual(payload);
  });

  test("deletes signals of excluded brands older than 90 days, keeps the brand", async () => {
    const excluded = await makeBrand(t.db, { excluded: true });
    const active = await makeBrand(t.db);
    await makeSignal(t.db, excluded.id, { signalDate: "2026-07-22" }); // 91 days
    await makeSignal(t.db, excluded.id, { signalDate: "2026-07-23" }); // 90 days
    await makeSignal(t.db, active.id, { signalDate: "2026-01-01" });

    const result = await runRetention(t.db, TODAY);
    expect(result.signalsDeleted).toBe(1);
    expect((await signalsOf(t.db, excluded.id)).map((s) => s.signalDate)).toEqual(["2026-07-23"]);
    expect(await signalsOf(t.db, active.id)).toHaveLength(1);
  });

  test("is idempotent", async () => {
    const b = await makeBrand(t.db);
    await makeSignal(t.db, b.id, { signalDate: "2026-01-01", rawPayload: jobPayload });
    await runRetention(t.db, TODAY);
    expect(await runRetention(t.db, TODAY)).toEqual({ descriptionsStripped: 0, signalsDeleted: 0 });
  });
});
