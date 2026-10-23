// One JSearch request per query per run.
export const JOB_QUERIES = [
  "Head of Retail",
  "Director of Retail",
  "VP Retail",
  "Director of Store Development",
  "Retail Real Estate Manager",
  "Pop-up Shop Manager",
  "Opening Store Manager",
  "Retail Experiential Manager",
] as const;

// Listings whose title doesn't match are dropped before insert.
export const RETAIL_TITLE_PATTERN =
  /retail|store|pop-?up|showroom|boutique|flagship|real estate|district manager|experiential/i;

// Entry-level and store-staff roles at existing stores, dropped even when the title says "retail"
// (JSearch matches "Head of Retail" to assistant managers and sales consultants). A growth word
// ("opening", "new store", "flagship", "pop-up", …) keeps the listing anyway.
export const JUNIOR_TITLE_PATTERN =
  /\b(assistant|associate|consultant|merchandiser|cashier|key ?holder|clerk|stock|team member|crew|part[- ]time|seasonal|sales (rep|representative|advisor|specialist))\b/i;
export const GROWTH_TITLE_PATTERN = /\b(opening|new stores?|first store|flagship|pop-?ups?|launch|expansion)\b/i;

export function isSeniorOrGrowthTitle(title: string): boolean {
  return GROWTH_TITLE_PATTERN.test(title) || !JUNIOR_TITLE_PATTERN.test(title);
}
