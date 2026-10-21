import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { DEV_USER_EMAIL, isAllowedEmail, isAuthDisabled, parseAllowedDomains } from "@/lib/auth-rules";

// Reads AUTH_SECRET, AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET from the environment.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    signIn({ user, profile }) {
      if (profile && profile.email_verified === false) return false;
      return isAllowedEmail(user.email, parseAllowedDomains(process.env.ALLOWED_EMAIL_DOMAINS));
    },
  },
});

// The signed-in rep's email, or null. Server Actions call this before touching data.
export async function currentUserEmail(): Promise<string | null> {
  if (isAuthDisabled()) return DEV_USER_EMAIL;
  const session = await auth();
  const email = session?.user?.email ?? null;
  // Re-check the allowlist in case it changed after the session was issued.
  return isAllowedEmail(email, parseAllowedDomains(process.env.ALLOWED_EMAIL_DOMAINS)) ? email : null;
}
