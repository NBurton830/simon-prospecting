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
