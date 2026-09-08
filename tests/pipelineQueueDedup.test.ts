import { describe, expect, it } from "vitest";
import type { DealTeamMember, LoanApplication } from "@shared/schema";
import { uniqueMemberApplications } from "../server/routes/underwriting/pipeline";

function application(id: string): LoanApplication {
  return { id } as LoanApplication;
}

function membership(id: string, app?: LoanApplication) {
  return { applicationId: id, application: app } as Pick<DealTeamMember, "applicationId"> & {
    application?: LoanApplication;
  };
}

describe("pipeline queue application identity", () => {
  it("returns one application when the same staffer has repeated or multiple-role memberships", () => {
    const first = application("app-1");
    const latest = application("app-1");
    const second = application("app-2");

    const result = uniqueMemberApplications([
      membership("app-1", first),
      membership("app-1", latest),
      membership("app-2", second),
      membership("missing"),
    ]);

    expect(result.map((item) => item.id)).toEqual(["app-1", "app-2"]);
    expect(result[0]).toBe(latest);
  });
});
