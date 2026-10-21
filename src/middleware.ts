import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { isAuthDisabled } from "@/lib/auth-rules";

// Every page requires a signed-in rep; Auth.js routes stay public so sign-in works.
const requireSignIn = auth((req) => {
  if (req.auth?.user) return NextResponse.next();
  const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(signInUrl);
});

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  if (isAuthDisabled()) return NextResponse.next();
  return (requireSignIn as unknown as (req: NextRequest, event: NextFetchEvent) => Promise<Response>)(req, event);
}

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
