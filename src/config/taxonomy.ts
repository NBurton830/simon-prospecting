// Shared by the DB layer, the Claude output schema, and the dashboard filters.

export const CATEGORIES = [
  "Apparel",
  "Footwear",
  "Beauty & Cosmetics",
  "Health & Wellness",
  "Jewelry & Accessories",
  "Home Goods",
  "Food & Beverage",
  "Consumer Electronics",
  "Pets",
  "Kids & Baby",
  "Sports & Outdoors",
  "Other",
] as const;

export const EXPANSION_STAGES = [
  "Online Only",
  "Wholesale / Shop-in-Shop",
  "Testing Pop-ups",
  "Opening Flagship",
  "Regional Rollout",
  "National Rollout",
  "Unknown",
] as const;

export const MEDIA_FORMATS = [
  "Digital Directories",
  "Atrium Banners",
  "Skyline Banners",
  "Concourse Pop-ups",
  "Pop-Up Kiosks",
  "Court Sponsorships",
  "Experiential Activations",
] as const;

export const PROSPECT_STATUSES = ["NEW", "REVIEWED", "CONTACTED", "ARCHIVED"] as const;

export const SIGNAL_TYPES = ["SEC_FORM_D", "JOB_LISTING"] as const;

export const SIGNAL_STATUSES = ["PENDING", "PROCESSING", "PROCESSED", "SKIPPED", "FAILED"] as const;

// Form D industryGroupType values that can be a consumer brand (verified against live filings, Oct 2026).
export const FORM_D_INDUSTRY_GROUPS = ["Retailing", "Restaurants", "Manufacturing", "Other"] as const;

export type Category = (typeof CATEGORIES)[number];
export type ExpansionStage = (typeof EXPANSION_STAGES)[number];
export type MediaFormat = (typeof MEDIA_FORMATS)[number];
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export type SignalType = (typeof SIGNAL_TYPES)[number];
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];
