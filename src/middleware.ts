import createIntlMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";
import { resolveTenant } from "@/server/tenant";
import {
  assertProxyHeaderPresent,
  ProductionGuardError,
} from "@/server/boot/production-guards";

const intlMiddleware = createIntlMiddleware(routing);

export default async function middleware(request: NextRequest) {
  try {
    assertProxyHeaderPresent(request.headers);
  } catch (err) {
    if (err instanceof ProductionGuardError) {
      return new NextResponse(err.code, { status: 503 });
    }
    throw err;
  }
  const tenant = await resolveTenant(request.headers.get("host"));
  if (!tenant) {
    return new NextResponse("Not Found", { status: 404 });
  }
  const response = intlMiddleware(request);
  response.headers.set("x-tenant-id", tenant.id);
  response.headers.set("x-tenant-domain", tenant.primaryDomain);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
  runtime: "nodejs",
};
