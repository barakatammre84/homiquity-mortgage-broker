import { describe, expect, it } from "vitest";
import { reportedBusinessCandidates } from "../server/services/reportedBusinessEntities";

describe("reported business entity projection", () => {
  it("creates one stable candidate from a named self-employment source", () => {
    expect(reportedBusinessCandidates([{
      type: "self_employed",
      annualAmount: "50000",
      employerName: " North Star Consulting, LLC ",
      businessStructure: "single_member_llc",
      ownershipPercent: "100",
    }])).toEqual([{
      identityKey: "name:north star consulting llc",
      entityType: "single_member_llc",
      name: "North Star Consulting, LLC",
      ownershipPercent: "100.00",
    }]);
  });

  it("does not invent a mortgage business from wages, rentals, or an unknown structure", () => {
    expect(reportedBusinessCandidates([
      { type: "w2", annualAmount: "90000", employerName: "Acme" },
      { type: "rental", annualAmount: "12000" },
      {
        type: "self_employed",
        annualAmount: "5000",
        employerName: "Contract payer",
        businessStructure: "other",
        ownershipPercent: "0",
      },
    ])).toEqual([]);
  });
});
