import { z } from "zod";
import { CATEGORIES, EXPANSION_STAGES, MEDIA_FORMATS } from "@/config/taxonomy";

export const AnalysisSchema = z.object({
  is_consumer_brand: z.boolean(),
  exclusion_reason: z.string().nullable(),
  brand_name: z.string(),
  category: z.enum(CATEGORIES),
  description: z.string(), // one sentence: what they sell, to whom
  expansion_stage: z.enum(EXPANSION_STAGES),
  funding_summary: z.string(),
  key_hiring_roles: z.array(z.string()),
  target_demographics: z.string(),
  retail_hiring_score: z.number().int().min(0).max(30),
  physical_stage_score: z.number().int().min(0).max(20),
  category_fit_score: z.number().int().min(0).max(10),
  score_rationale: z.string(),
  pitch_angle: z.string(),
  recommended_formats: z.array(z.enum(MEDIA_FORMATS)).min(1).max(3),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

// JSON Schema passed to `claude -p --json-schema`. The CLI silently ignores a schema that
// carries Zod's "$schema" draft marker (no structured_output, no error), so it is stripped.
export function analysisJsonSchema(): Record<string, unknown> {
  const { $schema: _draft, ...schema } = z.toJSONSchema(AnalysisSchema) as Record<string, unknown>;
  return schema;
}
