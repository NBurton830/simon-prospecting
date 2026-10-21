// Employers whose job listings are never treated as emerging-brand signals:
// established chains, department stores, and staffing agencies.
// Matched after normalizeCompanyName(), so suffixes like "Inc." don't matter.
export const EXCLUDED_EMPLOYERS = [
  "Walmart",
  "Target",
  "Costco",
  "Amazon",
  "The Home Depot",
  "Lowe's",
  "Kroger",
  "Walgreens",
  "CVS Health",
  "Macy's",
  "Nordstrom",
  "Kohl's",
  "TJX Companies",
  "Ross Stores",
  "Best Buy",
  "Dollar General",
  "Dollar Tree",
  "Starbucks",
  "McDonald's",
  "Ulta Beauty",
  "Sephora",
  "Gap",
  "Old Navy",
  "Foot Locker",
  "Dick's Sporting Goods",
  "Robert Half",
  "Adecco",
  "Randstad",
  "Kelly Services",
  "ManpowerGroup",
  "Aerotek",
  "Insight Global",
] as const;

// An employer with more listings than this in one run is treated as an established chain.
export const HIGH_VOLUME_EMPLOYER_THRESHOLD = 15;
