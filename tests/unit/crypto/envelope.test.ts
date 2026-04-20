import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  FORMAT_VERSION_V1,
  decryptTierAPayload,
  encryptTierAPayload,
  generateDek,
  readFormatVersion,
  unwrapDek,
  wrapDek,
} from "@/server/crypto/envelope";

const TENANT_A = "00000000-0000-0000-0000-0000000000aa";
const TENANT_B = "00000000-0000-0000-0000-0000000000bb";
const RECORD = "11111111-2222-3333-4444-555555555555";

beforeAll(() => {
  const env = process.env as Record<string, string | undefined>;
  env.DATA_KEK_BASE64 = randomBytes(32).toString("base64");
});

describe("Tier-A envelope", () => {
  it("wrap/unwrap DEK round-trips with version byte", () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, TENANT_A, 1);
    expect(readFormatVersion(wrapped)).toBe(FORMAT_VERSION_V1);
    expect(unwrapDek(wrapped, TENANT_A, 1).equals(dek)).toBe(true);
  });

  it("wrapped DEK is AAD-bound to tenant_id", () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, TENANT_A, 1);
    expect(() => unwrapDek(wrapped, TENANT_B, 1)).toThrow();
  });

  it("wrapped DEK is AAD-bound to dek_version", () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, TENANT_A, 1);
    expect(() => unwrapDek(wrapped, TENANT_A, 2)).toThrow();
  });

  it("payload encrypt/decrypt round-trips with version byte", () => {
    const dek = generateDek();
    const plaintext = Buffer.from(JSON.stringify({ national_id: "1234567890" }));
    const blob = encryptTierAPayload(plaintext, dek, TENANT_A, RECORD, 1);
    expect(readFormatVersion(blob)).toBe(FORMAT_VERSION_V1);
    expect(decryptTierAPayload(blob, dek, TENANT_A, RECORD, 1).equals(plaintext)).toBe(true);
  });

  it("payload is AAD-bound to record id", () => {
    const dek = generateDek();
    const blob = encryptTierAPayload(Buffer.from("x"), dek, TENANT_A, RECORD, 1);
    expect(() => decryptTierAPayload(blob, dek, TENANT_A, "99999999-2222-3333-4444-555555555555", 1)).toThrow();
  });

  it("rejects unsupported format versions", () => {
    const dek = generateDek();
    const blob = encryptTierAPayload(Buffer.from("x"), dek, TENANT_A, RECORD, 1);
    // Tamper with the version byte.
    const tampered = Buffer.from(blob);
    tampered.writeUInt8(99, 0);
    expect(() => decryptTierAPayload(tampered, dek, TENANT_A, RECORD, 1)).toThrow(/format version/);
  });
});
