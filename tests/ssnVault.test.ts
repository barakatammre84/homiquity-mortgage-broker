import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  isMaskedSsn,
  normalizeSsn,
  encryptSsnToColumns,
  decryptSsnFromRow,
  maskedSsnFromRow,
  resolveSsnInput,
  clearedSsnColumns,
} from "../server/services/ssnVault";

describe("ssnVault", () => {
  it("has no browser route that returns a decrypted SSN", () => {
    const borrowerRoutes = readFileSync(join(process.cwd(), "server/routes/borrower/urla.ts"), "utf8");
    expect(borrowerRoutes).not.toContain("/api/urla/:applicationId/ssn");
  });

  describe("normalizeSsn", () => {
    it("canonicalizes 9 digits regardless of separators", () => {
      expect(normalizeSsn("123456789")).toBe("123-45-6789");
      expect(normalizeSsn("123-45-6789")).toBe("123-45-6789");
      expect(normalizeSsn("123 45 6789")).toBe("123-45-6789");
    });

    it("rejects values without exactly 9 digits", () => {
      expect(normalizeSsn("12345678")).toBeNull();
      expect(normalizeSsn("1234567890")).toBeNull();
      expect(normalizeSsn("")).toBeNull();
      expect(normalizeSsn("abc")).toBeNull();
    });
  });

  describe("isMaskedSsn", () => {
    it("detects UI mask echoes", () => {
      expect(isMaskedSsn("XXX-XX-1234")).toBe(true);
      expect(isMaskedSsn("xxx-xx-1234")).toBe(true);
      expect(isMaskedSsn("•••-••-1234")).toBe(true);
      expect(isMaskedSsn("***-**-1234")).toBe(true);
    });

    it("does not flag real SSNs", () => {
      expect(isMaskedSsn("123-45-6789")).toBe(false);
      expect(isMaskedSsn("123456789")).toBe(false);
    });
  });

  describe("encrypt/decrypt round trip", () => {
    it("round-trips a canonical SSN and never stores plaintext", () => {
      const columns = encryptSsnToColumns("123-45-6789");
      expect(columns.ssn).toBeNull();
      expect(columns.ssnEncrypted).toBeTruthy();
      expect(columns.ssnEncrypted).not.toContain("123");
      expect(columns.ssnLast4).toBe("6789");
      expect(columns.ssnKeyId).toBe("v1");
      expect(decryptSsnFromRow(columns)).toBe("123-45-6789");
    });

    it("uses a fresh IV per encryption", () => {
      const a = encryptSsnToColumns("123-45-6789");
      const b = encryptSsnToColumns("123-45-6789");
      expect(a.ssnIv).not.toBe(b.ssnIv);
      expect(a.ssnEncrypted).not.toBe(b.ssnEncrypted);
    });
  });

  describe("decryptSsnFromRow legacy fallback", () => {
    it("falls back to plaintext rows the backfill has not reached", () => {
      expect(decryptSsnFromRow({ ssn: "123456789", ssnEncrypted: null, ssnIv: null, ssnKeyId: null, ssnLast4: null }))
        .toBe("123-45-6789");
    });

    it("never returns a masked value as the SSN", () => {
      expect(decryptSsnFromRow({ ssn: "XXX-XX-1234", ssnEncrypted: null, ssnIv: null, ssnKeyId: null, ssnLast4: null }))
        .toBeNull();
    });

    it("returns null for empty rows", () => {
      expect(decryptSsnFromRow({ ssn: null, ssnEncrypted: null, ssnIv: null, ssnKeyId: null, ssnLast4: null }))
        .toBeNull();
    });
  });

  describe("maskedSsnFromRow", () => {
    it("masks from ssnLast4", () => {
      const columns = encryptSsnToColumns("123-45-6789");
      expect(maskedSsnFromRow(columns)).toBe("XXX-XX-6789");
    });

    it("masks legacy plaintext rows on the way out", () => {
      expect(maskedSsnFromRow({ ssn: "123-45-6789", ssnLast4: null })).toBe("XXX-XX-6789");
    });

    it("returns null when nothing is stored", () => {
      expect(maskedSsnFromRow({ ssn: null, ssnLast4: null })).toBeNull();
    });
  });

  describe("resolveSsnInput (upsert semantics)", () => {
    it("keeps the stored SSN when the field is absent", () => {
      expect(resolveSsnInput(undefined)).toEqual({ action: "keep" });
    });

    it("keeps the stored SSN when the UI echoes the mask back", () => {
      expect(resolveSsnInput("XXX-XX-6789")).toEqual({ action: "keep" });
    });

    it("clears on explicit empty value", () => {
      expect(resolveSsnInput("")).toEqual({ action: "clear" });
      expect(resolveSsnInput(null)).toEqual({ action: "clear" });
      expect(clearedSsnColumns().ssnEncrypted).toBeNull();
    });

    it("rejects invalid values", () => {
      expect(resolveSsnInput("12-34")).toEqual({ action: "invalid" });
    });

    it("encrypts valid input", () => {
      const result = resolveSsnInput("987654321");
      expect(result.action).toBe("set");
      if (result.action === "set") {
        expect(result.columns.ssnLast4).toBe("4321");
        expect(decryptSsnFromRow(result.columns)).toBe("987-65-4321");
      }
    });
  });
});
