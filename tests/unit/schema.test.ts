import { describe, expect, test } from "vitest";
import { CATEGORIES, EXPANSION_STAGES, MEDIA_FORMATS } from "@/config/taxonomy";
import { AnalysisSchema, analysisJsonSchema } from "@/lib/analysis/schema";
import { fixtureJson, realBrandAnalysis, realExcludedAnalysis } from "../helpers/fixtures";

describe("AnalysisSchema", () => {
  test("accepts real Claude Code output for a brand and for an excluded fund", () => {
    expect(AnalysisSchema.safeParse(realBrandAnalysis()).success).toBe(true);
    expect(AnalysisSchema.safeParse(realExcludedAnalysis()).success).toBe(true);
  });

  test("rejects a category or format outside the taxonomy", () => {
    const bad = fixtureJson("claude-code/success-schema-invalid.DERIVED.stdout.json").structured_output;
    const result = AnalysisSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    expect(paths).toContain("category");
    expect(paths).toContain("recommended_formats.0");
  });

  test.each([
    ["retail_hiring_score", 31],
    ["retail_hiring_score", -1],
    ["physical_stage_score", 21],
    ["category_fit_score", 11],
    ["category_fit_score", 7.5],
  ])("rejects %s = %s", (field, value) => {
    expect(AnalysisSchema.safeParse({ ...realBrandAnalysis(), [field]: value }).success).toBe(false);
  });

  test("requires 1 to 3 recommended formats", () => {
    expect(AnalysisSchema.safeParse({ ...realBrandAnalysis(), recommended_formats: [] }).success).toBe(false);
    expect(
      AnalysisSchema.safeParse({ ...realBrandAnalysis(), recommended_formats: MEDIA_FORMATS.slice(0, 4) }).success,
    ).toBe(false);
  });

  test("allows a null exclusion_reason but not a missing one", () => {
    const { exclusion_reason: _omit, ...missing } = realBrandAnalysis();
    expect(AnalysisSchema.safeParse(missing).success).toBe(false);
    expect(AnalysisSchema.safeParse({ ...realBrandAnalysis(), exclusion_reason: null }).success).toBe(true);
  });
});

describe("analysisJsonSchema (passed to claude --json-schema)", () => {
  const schema = analysisJsonSchema() as any;

  test("has no $schema key — the CLI silently ignores schemas that carry one", () => {
    expect(schema).not.toHaveProperty("$schema");
  });

  test("requires every field and allows no extras", () => {
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(AnalysisSchema.shape).sort());
  });

  test("carries the taxonomy enums", () => {
    expect(schema.properties.category.enum).toEqual([...CATEGORIES]);
    expect(schema.properties.expansion_stage.enum).toEqual([...EXPANSION_STAGES]);
    expect(schema.properties.recommended_formats.items.enum).toEqual([...MEDIA_FORMATS]);
  });

  test("is serializable as a single CLI argument", () => {
    expect(() => JSON.parse(JSON.stringify(schema))).not.toThrow();
  });
});
