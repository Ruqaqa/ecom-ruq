import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isRealProduction,
  assertDangerousEnvFlagsUnset,
  assertBetterAuthDbRoleSafe,
  assertProxyHeaderPresent,
  runBootGuards,
  ProductionGuardError,
} from "@/server/boot/production-guards";

// vi.stubEnv restores on vi.unstubAllEnvs(). Each test stubs the specific
// env combination it needs; the afterEach clears them before the next test.
afterEach(() => {
  vi.unstubAllEnvs();
});

function stubHeaders(entries: Record<string, string> = {}) {
  return {
    get(name: string): string | null {
      const key = name.toLowerCase();
      for (const [k, v] of Object.entries(entries)) {
        if (k.toLowerCase() === key) return v;
      }
      return null;
    },
  };
}

describe("isRealProduction", () => {
  it("returns false when NODE_ENV is development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ENV", "");
    expect(isRealProduction()).toBe(false);
  });

  it("returns false when NODE_ENV is test", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("APP_ENV", "");
    expect(isRealProduction()).toBe(false);
  });

  it("returns true when NODE_ENV=production and APP_ENV is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "");
    expect(isRealProduction()).toBe(true);
  });

  it("returns true when NODE_ENV=production and APP_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    expect(isRealProduction()).toBe(true);
  });

  it("returns false when APP_ENV=e2e (harness escape hatch)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "e2e");
    expect(isRealProduction()).toBe(false);
  });

  it("returns false when APP_ENV=seed (seed harness)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "seed");
    expect(isRealProduction()).toBe(false);
  });
});

describe("assertDangerousEnvFlagsUnset", () => {
  it("is a no-op in development, even when dangerous flags are set", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("E2E_AUTH_RATE_LIMIT_DISABLED", "1");
    vi.stubEnv("MCP_RUN_SQL_ENABLED", "1");
    expect(() => assertDangerousEnvFlagsUnset()).not.toThrow();
  });

  it("is a no-op under e2e harness, even when rate-limit-disabled is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "e2e");
    vi.stubEnv("E2E_AUTH_RATE_LIMIT_DISABLED", "1");
    expect(() => assertDangerousEnvFlagsUnset()).not.toThrow();
  });

  it("throws ProductionGuardError when E2E_AUTH_RATE_LIMIT_DISABLED=1 in real prod", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("E2E_AUTH_RATE_LIMIT_DISABLED", "1");
    expect(() => assertDangerousEnvFlagsUnset()).toThrow(ProductionGuardError);
    try {
      assertDangerousEnvFlagsUnset();
    } catch (err) {
      expect(err).toBeInstanceOf(ProductionGuardError);
      expect((err as ProductionGuardError).code).toBe(
        "dangerous_env_flag_in_production",
      );
      expect((err as Error).message).toContain("E2E_AUTH_RATE_LIMIT_DISABLED");
    }
  });

  it("throws when MCP_RUN_SQL_ENABLED=1 in real prod", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("MCP_RUN_SQL_ENABLED", "1");
    expect(() => assertDangerousEnvFlagsUnset()).toThrow(ProductionGuardError);
  });

  it("does not throw when the flag is set to a non-dangerous value", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("E2E_AUTH_RATE_LIMIT_DISABLED", "0");
    vi.stubEnv("MCP_RUN_SQL_ENABLED", "");
    expect(() => assertDangerousEnvFlagsUnset()).not.toThrow();
  });

  it("does not throw when all flags are unset in real prod", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("E2E_AUTH_RATE_LIMIT_DISABLED", "");
    vi.stubEnv("MCP_RUN_SQL_ENABLED", "");
    expect(() => assertDangerousEnvFlagsUnset()).not.toThrow();
  });
});

describe("assertBetterAuthDbRoleSafe", () => {
  it("is a no-op in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv(
      "DATABASE_URL_APP",
      "postgresql://app_user:pw@localhost:55432/ecom_ruq_dev",
    );
    expect(() => assertBetterAuthDbRoleSafe()).not.toThrow();
  });

  it("is a no-op under e2e harness", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "e2e");
    vi.stubEnv(
      "DATABASE_URL_APP",
      "postgresql://app_user:pw@localhost:55432/ecom_ruq_dev",
    );
    expect(() => assertBetterAuthDbRoleSafe()).not.toThrow();
  });

  it("throws in real prod when the BA URL connects as app_user", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv(
      "DATABASE_URL_BA",
      "postgresql://app_user:pw@db.example.com:5432/app",
    );
    expect(() => assertBetterAuthDbRoleSafe()).toThrow(ProductionGuardError);
    try {
      assertBetterAuthDbRoleSafe();
    } catch (err) {
      expect((err as ProductionGuardError).code).toBe("ba_db_role_app_user");
    }
  });

  it("prefers DATABASE_URL_BA over DATABASE_URL_APP when both are set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    // BA URL points at a safe role; APP URL at app_user. Guard must use BA URL.
    vi.stubEnv(
      "DATABASE_URL_BA",
      "postgresql://ba_writer:pw@db.example.com:5432/app",
    );
    vi.stubEnv(
      "DATABASE_URL_APP",
      "postgresql://app_user:pw@db.example.com:5432/app",
    );
    expect(() => assertBetterAuthDbRoleSafe()).not.toThrow();
  });

  it("falls back to DATABASE_URL_APP when DATABASE_URL_BA is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("DATABASE_URL_BA", "");
    vi.stubEnv(
      "DATABASE_URL_APP",
      "postgresql://app_user:pw@db.example.com:5432/app",
    );
    expect(() => assertBetterAuthDbRoleSafe()).toThrow(ProductionGuardError);
  });

  it("throws ba_db_url_missing in real prod when no URL is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("DATABASE_URL_BA", "");
    vi.stubEnv("DATABASE_URL_APP", "");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertBetterAuthDbRoleSafe()).toThrow(ProductionGuardError);
    try {
      assertBetterAuthDbRoleSafe();
    } catch (err) {
      expect((err as ProductionGuardError).code).toBe("ba_db_url_missing");
    }
  });

  it("throws ba_db_url_unparseable on an invalid URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("DATABASE_URL_BA", "this-is-not-a-url");
    expect(() => assertBetterAuthDbRoleSafe()).toThrow(ProductionGuardError);
    try {
      assertBetterAuthDbRoleSafe();
    } catch (err) {
      expect((err as ProductionGuardError).code).toBe("ba_db_url_unparseable");
    }
  });

  it("accepts a safe role (ba_writer, app_migrator, etc.)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv(
      "DATABASE_URL_BA",
      "postgresql://app_migrator:pw@db.example.com:5432/app",
    );
    expect(() => assertBetterAuthDbRoleSafe()).not.toThrow();
  });

  it("decodes percent-encoded usernames (defense against encoding bypass)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    // "app_user" → "app%5Fuser" (underscore percent-encoded). The guard must
    // decode before comparing, else the check is trivially bypassable.
    vi.stubEnv(
      "DATABASE_URL_BA",
      "postgresql://app%5Fuser:pw@db.example.com:5432/app",
    );
    expect(() => assertBetterAuthDbRoleSafe()).toThrow(ProductionGuardError);
  });

  it("catches the ?user= query param override (postgres-js honors it and it wins over userinfo)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    // Userinfo says `ba_writer` (safe) but the query param overrides it to
    // app_user at connection time. Guard must inspect both.
    vi.stubEnv(
      "DATABASE_URL_BA",
      "postgresql://ba_writer:pw@db.example.com:5432/app?user=app_user",
    );
    expect(() => assertBetterAuthDbRoleSafe()).toThrow(ProductionGuardError);
    try {
      assertBetterAuthDbRoleSafe();
    } catch (err) {
      expect((err as ProductionGuardError).code).toBe("ba_db_role_app_user");
    }
  });

  it("catches Unicode compatibility-variant usernames (fullwidth underscore)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    // U+FF3F FULLWIDTH LOW LINE normalizes to regular underscore under NFKC.
    // Without normalization, `app＿user` === "app_user" is false and the
    // guard would pass; with normalization, it folds back and trips.
    vi.stubEnv(
      "DATABASE_URL_BA",
      "postgresql://app＿user:pw@db.example.com:5432/app",
    );
    expect(() => assertBetterAuthDbRoleSafe()).toThrow(ProductionGuardError);
  });

  it("throws ba_db_url_unparseable on malformed percent-encoding", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    // `new URL` may accept this but `decodeURIComponent` will throw on %ZZ.
    // `safeDecode` wraps in try/catch and surfaces the same guard code.
    vi.stubEnv(
      "DATABASE_URL_BA",
      "postgresql://bad%ZZ:pw@db.example.com:5432/app",
    );
    expect(() => assertBetterAuthDbRoleSafe()).toThrow(ProductionGuardError);
  });
});

describe("assertProxyHeaderPresent", () => {
  it("is a no-op in development when header is missing", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertProxyHeaderPresent(stubHeaders({}))).not.toThrow();
  });

  it("is a no-op under e2e harness when header is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "e2e");
    expect(() => assertProxyHeaderPresent(stubHeaders({}))).not.toThrow();
  });

  it("throws in real prod when x-real-ip is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    expect(() => assertProxyHeaderPresent(stubHeaders({}))).toThrow(
      ProductionGuardError,
    );
    try {
      assertProxyHeaderPresent(stubHeaders({}));
    } catch (err) {
      expect((err as ProductionGuardError).code).toBe("proxy_header_missing");
    }
  });

  it("throws in real prod when x-real-ip is whitespace-only", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    expect(() =>
      assertProxyHeaderPresent(stubHeaders({ "x-real-ip": "   " })),
    ).toThrow(ProductionGuardError);
  });

  it("passes in real prod when x-real-ip is present", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    expect(() =>
      assertProxyHeaderPresent(stubHeaders({ "x-real-ip": "203.0.113.7" })),
    ).not.toThrow();
  });

  it("reads the header case-insensitively (Headers API convention)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    expect(() =>
      assertProxyHeaderPresent(stubHeaders({ "X-Real-IP": "203.0.113.7" })),
    ).not.toThrow();
  });
});

describe("runBootGuards", () => {
  it("runs all boot guards in sequence under real prod", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("E2E_AUTH_RATE_LIMIT_DISABLED", "");
    vi.stubEnv("MCP_RUN_SQL_ENABLED", "");
    vi.stubEnv(
      "DATABASE_URL_BA",
      "postgresql://ba_writer:pw@db.example.com:5432/app",
    );
    expect(() => runBootGuards()).not.toThrow();
  });

  it("is a no-op under e2e harness", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "e2e");
    vi.stubEnv("E2E_AUTH_RATE_LIMIT_DISABLED", "1");
    vi.stubEnv(
      "DATABASE_URL_APP",
      "postgresql://app_user:pw@localhost:55432/ecom_ruq_dev",
    );
    expect(() => runBootGuards()).not.toThrow();
  });

  it("refuses to start in real prod when a dangerous flag is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("E2E_AUTH_RATE_LIMIT_DISABLED", "1");
    expect(() => runBootGuards()).toThrow(ProductionGuardError);
  });

  it("refuses to start in real prod when BA URL is app_user", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("E2E_AUTH_RATE_LIMIT_DISABLED", "");
    vi.stubEnv("MCP_RUN_SQL_ENABLED", "");
    vi.stubEnv(
      "DATABASE_URL_BA",
      "postgresql://app_user:pw@db.example.com:5432/app",
    );
    expect(() => runBootGuards()).toThrow(ProductionGuardError);
  });
});
