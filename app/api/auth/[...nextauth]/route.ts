import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { checkLimit, tooManyRequests } from "@/lib/ratelimit";
import { clientIp } from "@/lib/security/tokens";

export const GET = handlers.GET;

/** Per-IP limit on login attempts made directly against the Auth.js API. */
export async function POST(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/auth/signin/")) {
    const r = await checkLimit("loginIp", clientIp(request.headers));
    if (!r.success) return tooManyRequests(r);
  }
  return handlers.POST(request);
}
