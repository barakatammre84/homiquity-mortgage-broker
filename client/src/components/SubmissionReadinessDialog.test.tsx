import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubmissionReadinessDialog } from "./SubmissionReadinessDialog";
import { loanApplicationKeys } from "@/lib/queryClient";

// F-0818-09. `wholesale_lenders` has TWO identifiers: a uuid primary key (`id`)
// and the business key (`lenderId`, e.g. "uwm"). The server resolves a
// submission with `getWholesaleLenderByLenderId` — WHERE lender_id = $1 — so
// posting the uuid throws "Unknown wholesale lender <uuid>" before the
// counterparty gate is even reached. #417 moved the catalog from a hardcoded
// {id,name} array into the table across 29 files and never updated this
// component, so it kept reading `name` (a column that does not exist) and
// sending `id`. These tests pin the identifier contract in both directions:
// what we SEND must be the business key, and what we SHOW must be lenderName.

const apiRequestMock = vi.fn();
vi.mock("@/lib/queryClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queryClient")>("@/lib/queryClient");
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequestMock(...args) };
});

const APP_ID = "app-1";

// Shaped as the route actually returns it: the whole row minus apiConfig
// (server/routes/underwriting/submissions.ts). Note `specialty` is nullable.
const lender = (over: Record<string, unknown> = {}) => ({
  id: "8f3a2b10-0000-4000-8000-000000000001",
  lenderId: "uwm",
  lenderName: "United Wholesale Mortgage",
  lenderCode: "UWM",
  approvalStatus: "approved",
  isDemo: false,
  specialty: "Non-QM and bank statement",
  ...over,
});

const readiness = (over: Record<string, unknown> = {}) => ({
  applicationId: APP_ID,
  readyToSubmitToLender: true,
  currentStage: "lenderPackage",
  stages: [],
  nextActions: [],
  ...over,
});

// Shaped exactly as server/services/ausSubmission.ts persists it and
// routes/aus.ts returns it on the application row: DU headline with the LPA
// leg nested under `lpa`, D1C relief per layer with a withhold reason.
const ausFindings = (over: Record<string, unknown> = {}) => ({
  simulated: true,
  casefileId: "sim-du-a34f919bf7",
  duVersion: "12.1",
  recommendation: "approve_eligible",
  riskAssessment: { dti: 0.3366, ltv: 0.8, creditScore: 744 },
  day1Certainty: {
    assets: { relief: false, reason: "No validated assets report on the casefile" },
    income: { relief: false, reason: "No validated income report on the casefile" },
  },
  messages: [
    { code: "DU-0001", severity: "info", text: "Casefile underwritten with no adverse findings." },
  ],
  lpa: {
    simulated: true,
    assessmentId: "sim-lpa-a34f919bf7",
    riskClass: "accept",
    purchaseEligibility: "eligible",
    messages: [],
  },
  ...over,
});

const applicationDetail = (over: Record<string, unknown> = {}) => ({
  application: {
    ausCasefileId: "sim-du-a34f919bf7",
    ausRecommendation: "approve_eligible",
    ausSubmittedAt: new Date("2026-08-23T18:21:00Z").toISOString(),
    ausFindings: ausFindings(),
    ...over,
  },
});

function renderDialog({
  lenders = [lender()],
  submissions = [] as Record<string, unknown>[],
  readinessOver = {} as Record<string, unknown>,
  detail = applicationDetail() as Record<string, unknown> | undefined,
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  client.setQueryData(loanApplicationKeys.submissionReadiness(APP_ID), readiness(readinessOver));
  client.setQueryData(["/api/wholesale-lenders"], lenders);
  client.setQueryData(loanApplicationKeys.lenderSubmissions(APP_ID), submissions);
  if (detail) client.setQueryData(loanApplicationKeys.detail(APP_ID), detail);
  return render(
    <QueryClientProvider client={client}>
      <SubmissionReadinessDialog applicationId={APP_ID} borrowerName="WFQA Six" />
    </QueryClientProvider>,
  );
}

const AUS_STAGE = {
  key: "aus",
  label: "Automated underwriting (DU + LPA)",
  status: "ready",
  blockers: [],
  warnings: [],
};

const openDialog = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(`submission-readiness-${APP_ID}`));
  return user;
};

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockResolvedValue({ json: async () => ({ id: "sub-1", lenderId: "uwm" }) });
});

describe("SubmissionReadinessDialog — the lender identifier contract (F-0818-09)", () => {
  it("shows the lender's NAME in an existing submission row, not the raw business key", async () => {
    // The helper looks a submission's lenderId up in the catalog. Matching it
    // against the uuid `id` never hits, so the row degrades to the slug.
    renderDialog({
      submissions: [
        {
          id: "sub-1",
          lenderId: "uwm",
          status: "in_underwriting",
          confirmationId: "CONF-8F3A2B",
          simulated: true,
          submittedAt: new Date("2026-08-18T12:00:00Z").toISOString(),
        },
      ],
    });
    await openDialog();
    const row = await screen.findByTestId("submission-row-sub-1");
    expect(row.textContent).toContain("United Wholesale Mortgage");
    expect(row.textContent).not.toContain("uwm");
  });

  it("renders each option by lenderName, and never emits the literal 'undefined'", async () => {
    renderDialog();
    const user = await openDialog();
    await user.click(screen.getByTestId("lender-select"));
    const option = await screen.findByTestId("lender-option-uwm");
    expect(option.textContent).toContain("United Wholesale Mortgage");
    expect(option.textContent).not.toContain("undefined");
  });

  it("submits the business lenderId, never the uuid primary key", async () => {
    renderDialog();
    const user = await openDialog();
    await user.click(screen.getByTestId("lender-select"));
    await user.click(await screen.findByTestId("lender-option-uwm"));
    await user.click(screen.getByTestId("submit-to-lender"));

    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    const [method, url, body] = apiRequestMock.mock.calls[0];
    expect(method).toBe("POST");
    expect(url).toBe(`/api/loan-applications/${APP_ID}/lender-submissions`);
    expect(body).toEqual({ lenderId: "uwm" });
    // The precise regression: a uuid here is what produced
    // "Unknown wholesale lender <uuid>" with an empty blockers array.
    expect((body as { lenderId: string }).lenderId).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("omits the separator when a lender has no specialty (demo rows have none)", async () => {
    renderDialog({ lenders: [lender({ specialty: null })] });
    const user = await openDialog();
    await user.click(screen.getByTestId("lender-select"));
    const option = await screen.findByTestId("lender-option-uwm");
    expect(option.textContent?.trim()).toBe("United Wholesale Mortgage");
  });
});

// -----------------------------------------------------------------------------
// The DU / LPA findings panel (Selling Guide B3-2-11; B3-2-01 p.290 calls the
// Findings report "typically the first report viewed by an underwriter or a
// loan officer"). Before 2026-08-23 the findings were persisted, returned to
// this client on the application row — and rendered NOWHERE: the LO's only
// view of a DU result was a transient toast. These tests pin the panel against
// the exact persisted shape, including the simulated label (Reality Map rule:
// sims are labeled) and the empty state.
// -----------------------------------------------------------------------------
describe("SubmissionReadinessDialog — DU / LPA findings panel (B3-2-11)", () => {
  it("disables AUS while required intake data is still blocked", async () => {
    renderDialog({
      readinessOver: {
        stages: [
          {
            key: "intake",
            label: "Complete intake",
            status: "blocked",
            blockers: ["SSN is required"],
            warnings: [],
          },
          { ...AUS_STAGE, status: "blocked", blockers: ["Complete intake first"] },
        ],
      },
      detail: applicationDetail({ ausCasefileId: null, ausRecommendation: null, ausFindings: null }),
    });
    await openDialog();

    expect((await screen.findByTestId("run-aus") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("run-aus-blocked-reason").textContent).toMatch(/complete the intake blockers/i);
  });

  it("renders recommendation, simulated label, LPA leg, messages, and D1C reasons from the persisted shape", async () => {
    renderDialog({ readinessOver: { stages: [AUS_STAGE] } });
    const user = await openDialog();

    await user.click(await screen.findByTestId("aus-findings-toggle"));

    const panel = await screen.findByTestId("aus-findings-panel");
    expect(screen.getByTestId("aus-findings-recommendation").textContent).toBe("Approve / Eligible");
    expect(screen.getByTestId("aus-findings-simulated").textContent).toContain("Simulated");
    expect(screen.getByTestId("aus-findings-lpa").textContent).toContain("accept");
    expect(screen.getByTestId("aus-findings-lpa").textContent).toContain("eligible");
    expect(screen.getByTestId("aus-findings-messages").textContent).toContain("DU-0001");
    expect(screen.getByTestId("aus-findings-messages").textContent).toContain(
      "Casefile underwritten with no adverse findings.",
    );
    expect(screen.getByTestId("aus-findings-d1c").textContent).toContain(
      "No validated assets report on the casefile",
    );
    expect(panel.textContent).toContain("sim-du-a34f919bf7");
    // Risk line renders as percentages, not raw ratios.
    expect(screen.getByTestId("aus-findings-risk").textContent).toContain("DTI 33.7%");
  });

  it("labels a refer_with_caution recommendation with its Guide vocabulary", async () => {
    renderDialog({
      readinessOver: { stages: [AUS_STAGE] },
      detail: applicationDetail({
        ausRecommendation: "refer_with_caution",
        ausFindings: ausFindings({ recommendation: "refer_with_caution" }),
      }),
    });
    const user = await openDialog();
    await user.click(await screen.findByTestId("aus-findings-toggle"));
    expect(screen.getByTestId("aus-findings-recommendation").textContent).toBe("Refer with Caution");
  });

  it("shows no findings toggle before any AUS run (no casefile on the row)", async () => {
    renderDialog({
      readinessOver: { stages: [AUS_STAGE] },
      detail: applicationDetail({ ausCasefileId: null, ausRecommendation: null, ausFindings: null }),
    });
    await openDialog();
    expect(await screen.findByTestId("run-aus")).toBeTruthy();
    expect(screen.queryByTestId("aus-findings-toggle")).toBeNull();
  });
});
