import { describe, expect, it } from "vitest";
import { UrlaStorage } from "../server/storage/urla";

describe("MISMO sensitive-data boundary", () => {
  it("assembles readiness data without decrypting taxpayer or account identifiers", async () => {
    const neverDecrypt = () => {
      throw new Error("readiness attempted to decrypt a sensitive identifier");
    };
    const fakeStorage = {
      getLoanApplication: async () => ({ id: "app-1", userId: "borrower-1" }),
      getUser: async () => ({ id: "borrower-1" }),
      getCompleteUrlaData: async () => ({
        personalInfo: { borrowerSequenceNumber: 1, ssn: "XXX-XX-6789", ssnLast4: "6789" },
        allPersonalInfo: [{ borrowerSequenceNumber: 1, ssn: "XXX-XX-6789", ssnLast4: "6789" }],
        employmentHistory: [],
        assets: [{
          accountNumberEncrypted: "must-not-be-decrypted",
          accountNumberIv: "must-not-be-decrypted",
          accountNumberKeyId: "must-not-be-decrypted",
        }],
        liabilities: [{
          accountNumberEncrypted: "must-not-be-decrypted",
          accountNumberIv: "must-not-be-decrypted",
          accountNumberKeyId: "must-not-be-decrypted",
        }],
        propertyInfo: null,
        declarations: null,
        allDeclarations: [],
      }),
      getLoanOptionsByApplication: async () => [],
      getDocumentsByApplication: async () => [],
      getDecryptedUrlaSsn: neverDecrypt,
    };

    const data = await UrlaStorage.prototype.getMISMOLoanData.call(fakeStorage, "app-1");

    expect(data?.personalInfo?.ssn).toBeNull();
    expect(data?.allPersonalInfo?.[0].ssn).toBeNull();
    expect(data?.assets[0].accountNumber).toBeNull();
    expect(data?.liabilities[0].accountNumber).toBeNull();
  });
});
