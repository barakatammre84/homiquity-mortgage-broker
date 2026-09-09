import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeGcs = vi.hoisted(() => ({ bytes: null as Buffer | null }));

vi.mock("@google-cloud/storage", () => ({
  File: class {},
  Storage: class {
    bucket() {
      return {
        file: () => ({
          exists: async () => [fakeGcs.bytes !== null],
          save: async (bytes: Buffer, options?: { preconditionOpts?: { ifGenerationMatch?: number } }) => {
            if (options?.preconditionOpts?.ifGenerationMatch === 0 && fakeGcs.bytes) {
              throw new Error("precondition failed");
            }
            fakeGcs.bytes = Buffer.from(bytes);
          },
          download: async () => {
            if (!fakeGcs.bytes) throw new Error("missing");
            return [Buffer.from(fakeGcs.bytes)];
          },
          delete: async ({ ignoreNotFound }: { ignoreNotFound: boolean }) => {
            if (!fakeGcs.bytes && !ignoreNotFound) throw new Error("missing");
            fakeGcs.bytes = null;
          },
        }),
      };
    }
  },
}));

import {
  ObjectStorageService,
  parsePrivateStorageRestartMarker,
  PrivateStorageRestartProofError,
  validatePrivateStorageRestartTransition,
  type PrivateStorageRestartMarker,
} from "../server/integrations/object_storage";

const seededAt = "2026-09-09T23:00:00.000Z";
const commitSha = "a".repeat(40);
const marker: PrivateStorageRestartMarker = {
  version: 1,
  sourceDeploymentId: "deployment-old",
  sourceCommitSha: commitSha,
  seededAt,
  nonce: "12345678-1234-1234-1234-123456789abc",
};

const originalEnvironment = {
  privateObjectDir: process.env.PRIVATE_OBJECT_DIR,
  deploymentId: process.env.RAILWAY_DEPLOYMENT_ID,
  commitSha: process.env.RAILWAY_GIT_COMMIT_SHA,
};

beforeEach(() => {
  fakeGcs.bytes = null;
  process.env.PRIVATE_OBJECT_DIR = "/test-private-bucket/private";
  process.env.RAILWAY_DEPLOYMENT_ID = "deployment-old";
  process.env.RAILWAY_GIT_COMMIT_SHA = commitSha;
});

afterEach(() => {
  for (const [key, value] of Object.entries({
    PRIVATE_OBJECT_DIR: originalEnvironment.privateObjectDir,
    RAILWAY_DEPLOYMENT_ID: originalEnvironment.deploymentId,
    RAILWAY_GIT_COMMIT_SHA: originalEnvironment.commitSha,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function failureCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateStorageRestartProofError);
    return (error as PrivateStorageRestartProofError).code;
  }
}

describe("private object storage restart proof", () => {
  it("accepts a fresh, integrity-shaped synthetic marker", () => {
    const parsed = parsePrivateStorageRestartMarker(
      Buffer.from(JSON.stringify(marker)),
      Date.parse("2026-09-09T23:20:00.000Z"),
    );
    expect(parsed).toEqual(marker);
  });

  it("rejects malformed and expired markers", () => {
    expect(failureCode(() => parsePrivateStorageRestartMarker(
      Buffer.from("not-json"),
      Date.parse("2026-09-09T23:20:00.000Z"),
    ))).toBe("marker_invalid");

    expect(failureCode(() => parsePrivateStorageRestartMarker(
      Buffer.from(JSON.stringify(marker)),
      Date.parse("2026-09-10T00:00:01.000Z"),
    ))).toBe("marker_expired");
  });

  it("fails closed until a different deployment serves the same commit", () => {
    expect(failureCode(() => validatePrivateStorageRestartTransition(
      marker,
      { deploymentId: marker.sourceDeploymentId, commitSha },
      new Date("2026-09-09T23:20:00.000Z"),
    ))).toBe("restart_not_observed");

    expect(failureCode(() => validatePrivateStorageRestartTransition(
      marker,
      { deploymentId: "deployment-new", commitSha: "b".repeat(40) },
      new Date("2026-09-09T23:20:00.000Z"),
    ))).toBe("commit_changed");
  });

  it("returns only safe proof metadata after a same-build restart", () => {
    const result = validatePrivateStorageRestartTransition(
      marker,
      { deploymentId: "deployment-new", commitSha },
      new Date("2026-09-09T23:20:00.000Z"),
    );
    expect(result).toEqual({
      status: "verified",
      sourceCommitSha: commitSha,
      currentCommitSha: commitSha,
      seededAt,
      verifiedAt: "2026-09-09T23:20:00.000Z",
      ageMs: 20 * 60 * 1_000,
    });
    expect(JSON.stringify(result)).not.toContain(marker.sourceDeploymentId);
    expect(JSON.stringify(result)).not.toContain(marker.nonce);
  });

  it("seeds idempotently, refuses the same process, then reads and deletes after restart", async () => {
    const service = new ObjectStorageService();
    const seed = await service.seedPrivateStorageRestartProof(new Date(seededAt));
    expect(seed).toMatchObject({ status: "seeded", reused: false, sourceCommitSha: commitSha });
    expect(await service.seedPrivateStorageRestartProof(new Date(seededAt))).toMatchObject({
      status: "seeded",
      reused: true,
    });

    await expect(service.verifyPrivateStorageRestartProof(
      new Date("2026-09-09T23:10:00.000Z"),
    )).rejects.toMatchObject({ code: "restart_not_observed" });
    expect(fakeGcs.bytes).not.toBeNull();

    process.env.RAILWAY_DEPLOYMENT_ID = "deployment-new";
    const verified = await service.verifyPrivateStorageRestartProof(
      new Date("2026-09-09T23:20:00.000Z"),
    );
    expect(verified).toMatchObject({ status: "verified", ageMs: 20 * 60 * 1_000 });
    expect(fakeGcs.bytes).toBeNull();
  });

  it("keeps the marker when a different commit attempts verification", async () => {
    const service = new ObjectStorageService();
    await service.seedPrivateStorageRestartProof(new Date(seededAt));
    process.env.RAILWAY_DEPLOYMENT_ID = "deployment-new";
    process.env.RAILWAY_GIT_COMMIT_SHA = "b".repeat(40);
    await expect(service.verifyPrivateStorageRestartProof(
      new Date("2026-09-09T23:20:00.000Z"),
    )).rejects.toMatchObject({ code: "commit_changed" });
    expect(fakeGcs.bytes).not.toBeNull();
  });
});
