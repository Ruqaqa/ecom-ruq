import { describe, it, expect, afterEach } from "vitest";
import { resolveTenant } from "@/server/tenant";

const env = process.env as Record<string, string | undefined>;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) snapshot[key] = env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

afterEach(() => {
  // Belt-and-braces: ensure no stray ALLOW_TENANT_FALLBACK leaks between tests.
  delete env.ALLOW_TENANT_FALLBACK;
});

describe("tenant resolver", () => {
  it("matches known hosts case-insensitively", () => {
    const tenant = resolveTenant("ECOM.RUQAQA.SA");
    expect(tenant?.id).toBe("ruqaqa");
    expect(tenant?.defaultLocale).toBe("ar");
  });

  it("unknown host returns null by default (fail closed)", () => {
    withEnv({ NODE_ENV: "development", ALLOW_TENANT_FALLBACK: undefined }, () => {
      expect(resolveTenant("unknown.example.com")).toBeNull();
      expect(resolveTenant(null)).toBeNull();
    });
  });

  it("unknown host returns null in production regardless of ALLOW_TENANT_FALLBACK", () => {
    withEnv({ NODE_ENV: "production", ALLOW_TENANT_FALLBACK: "1" }, () => {
      expect(resolveTenant("unknown.example.com")).toBeNull();
    });
  });

  it("unknown host returns fallback when ALLOW_TENANT_FALLBACK=1 in dev", () => {
    withEnv({ NODE_ENV: "development", ALLOW_TENANT_FALLBACK: "1" }, () => {
      expect(resolveTenant("unknown.example.com")?.id).toBe("ruqaqa-local");
      expect(resolveTenant(null)?.id).toBe("ruqaqa-local");
    });
  });
});
