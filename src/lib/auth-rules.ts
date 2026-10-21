// Access rules for the dashboard, kept free of Next.js/Auth.js imports so they can be unit tested.

// "company.com, partner.com" → ["company.com", "partner.com"]
export function parseAllowedDomains(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

// Exact domain match, case-insensitive. An empty allowlist lets nobody in.
export function isAllowedEmail(email: string | null | undefined, allowedDomains: string[]): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  return allowedDomains.includes(email.slice(at + 1).trim().toLowerCase());
}

// Local development only: AUTH_DISABLED=true skips sign-in. Never honored in production builds.
export function isAuthDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && env.AUTH_DISABLED === "true";
}

export const DEV_USER_EMAIL = "dev@localhost";
