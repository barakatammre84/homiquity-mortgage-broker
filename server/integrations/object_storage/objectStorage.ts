import { Storage, File } from "@google-cloud/storage";
import { Response } from "express";
import { createHash, randomUUID } from "crypto";
import { UPLOAD_CREATE_ONLY_HEADER, UPLOAD_CREATE_ONLY_VALUE } from "@shared/uploads";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

// Credential resolution, in order:
// 1. GCS_SERVICE_ACCOUNT_KEY — the full service-account JSON in an env var.
//    Works on any host (Railway, local) and enables native V4 URL signing.
// 2. Application Default Credentials — GOOGLE_APPLICATION_CREDENTIALS file
//    path, gcloud auth, or GCE/Cloud Run metadata.
function createStorageClient(): Storage {
  const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
  if (keyJson) {
    const credentials = JSON.parse(keyJson);
    return new Storage({
      credentials,
      projectId: credentials.project_id,
    });
  }

  return new Storage();
}

// The object storage client is used to interact with the object storage service.
export const objectStorageClient = createStorageClient();

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export type PrivateStorageRestartProofFailure =
  | "runtime_identity_missing"
  | "proof_in_progress"
  | "proof_missing"
  | "restart_not_observed"
  | "commit_changed"
  | "marker_expired"
  | "marker_invalid";

export class PrivateStorageRestartProofError extends Error {
  constructor(readonly code: PrivateStorageRestartProofFailure) {
    super(code);
    this.name = "PrivateStorageRestartProofError";
    Object.setPrototypeOf(this, PrivateStorageRestartProofError.prototype);
  }
}

export interface PrivateStorageRestartMarker {
  version: 1;
  sourceDeploymentId: string;
  sourceCommitSha: string;
  seededAt: string;
  nonce: string;
}

export interface PrivateStorageRestartSeedResult {
  status: "seeded";
  sourceCommitSha: string;
  seededAt: string;
  reused: boolean;
}

export interface PrivateStorageRestartVerifyResult {
  status: "verified";
  sourceCommitSha: string;
  currentCommitSha: string;
  seededAt: string;
  verifiedAt: string;
  ageMs: number;
}

const RESTART_PROOF_MAX_AGE_MS = 60 * 60 * 1_000;

function runtimeDeploymentIdentity(): { deploymentId: string; commitSha: string } {
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim();
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (!deploymentId || !commitSha) {
    throw new PrivateStorageRestartProofError("runtime_identity_missing");
  }
  return { deploymentId, commitSha };
}

export function parsePrivateStorageRestartMarker(
  bytes: Buffer,
  nowMs = Date.now(),
): PrivateStorageRestartMarker {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PrivateStorageRestartProofError("marker_invalid");
  }
  const marker = value as Partial<PrivateStorageRestartMarker>;
  const seededMs = typeof marker.seededAt === "string" ? Date.parse(marker.seededAt) : NaN;
  if (
    marker.version !== 1 ||
    typeof marker.sourceDeploymentId !== "string" || marker.sourceDeploymentId.length < 8 ||
    typeof marker.sourceCommitSha !== "string" || !/^[0-9a-f]{40}$/i.test(marker.sourceCommitSha) ||
    typeof marker.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(marker.nonce) ||
    !Number.isFinite(seededMs)
  ) {
    throw new PrivateStorageRestartProofError("marker_invalid");
  }
  if (seededMs > nowMs + 5_000 || nowMs - seededMs > RESTART_PROOF_MAX_AGE_MS) {
    throw new PrivateStorageRestartProofError("marker_expired");
  }
  return marker as PrivateStorageRestartMarker;
}

export function validatePrivateStorageRestartTransition(
  marker: PrivateStorageRestartMarker,
  current: { deploymentId: string; commitSha: string },
  now = new Date(),
): PrivateStorageRestartVerifyResult {
  if (marker.sourceDeploymentId === current.deploymentId) {
    throw new PrivateStorageRestartProofError("restart_not_observed");
  }
  if (marker.sourceCommitSha !== current.commitSha) {
    throw new PrivateStorageRestartProofError("commit_changed");
  }
  const seededMs = Date.parse(marker.seededAt);
  return {
    status: "verified",
    sourceCommitSha: marker.sourceCommitSha,
    currentCommitSha: current.commitSha,
    seededAt: marker.seededAt,
    verifiedAt: now.toISOString(),
    ageMs: now.getTime() - seededMs,
  };
}

// The object storage service is used to interact with the object storage service.
export class ObjectStorageService {
  constructor() {}

  // Gets the public object search paths.
  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  // Gets the private object directory.
  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  // Search for a public object from the search paths.
  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      // Full path format: /<bucket_name>/<object_name>
      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      // Check if file exists
      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  // Downloads an object to the response.
  async downloadObject(file: File, res: Response, cacheTtlSec: number = 3600) {
    try {
      // Get file metadata
      const [metadata] = await file.getMetadata();
      // Get the ACL policy for the object.
      const aclPolicy = await getObjectAclPolicy(file);
      const isPublic = aclPolicy?.visibility === "public";
      // Set appropriate headers
      res.set({
        "Content-Type": metadata.contentType || "application/octet-stream",
        "Content-Length": metadata.size,
        "Cache-Control": `${
          isPublic ? "public" : "private"
        }, max-age=${cacheTtlSec}`,
      });

      // Stream the file to the response
      const stream = file.createReadStream();

      stream.on("error", (err) => {
        console.error("Stream error:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Error streaming file" });
        }
      });

      stream.pipe(res);
    } catch (error) {
      console.error("Error downloading file:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error downloading file" });
      }
    }
  }

  // Gets the upload URL for an object entity.
  async getObjectEntityUploadURL(contentType: string): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    // Sign URL for PUT method with TTL
    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
      contentType,
      extensionHeaders: { [UPLOAD_CREATE_ONLY_HEADER]: UPLOAD_CREATE_ONLY_VALUE },
    });
  }

  // Gets the object entity file from the object path.
  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  /** SHA-256 of the stored bytes, calculated server-side after upload. */
  async sha256ObjectEntity(objectPath: string): Promise<string> {
    const objectFile = await this.getObjectEntityFile(objectPath);
    const hash = createHash("sha256");
    for await (const chunk of objectFile.createReadStream()) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  normalizeObjectEntityPath(
    rawPath: string,
  ): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }
  
    // Extract the path from the URL by removing query parameters and domain
    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;
  
    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }
  
    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }
  
    // Extract the entity ID from the path
    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  // Tries to set the ACL policy for the object entity and return the normalized path.
  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  // Checks if the user can access the object entity.
  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  /** True when object storage is configured (a private bucket dir is set). */
  isConfigured(): boolean {
    return !!process.env.PRIVATE_OBJECT_DIR;
  }

  /**
   * Complete a private write/read/delete round trip with synthetic bytes.
   * The object is never registered as a borrower document and is removed in a
   * finally block. This proves bucket access without retaining a payload or
   * exposing the configured bucket name through an API response.
   */
  async verifyPrivateStorageRoundTrip(): Promise<void> {
    const privateDir = this.getPrivateObjectDir();
    const { bucketName, objectName: privatePrefix } = parseObjectPath(privateDir);
    const canaryId = randomUUID();
    const objectName = `${privatePrefix.replace(/\/$/, "")}/canaries/${canaryId}.txt`;
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const payload = Buffer.from(`homiquity-storage-canary:${canaryId}`, "utf8");

    try {
      await file.save(payload, {
        contentType: "text/plain",
        resumable: false,
        validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { cacheControl: "private, no-store" },
      });
      const [downloaded] = await file.download({ validation: "crc32c" });
      if (!downloaded.equals(payload)) {
        throw new Error("Private object storage canary returned different bytes");
      }
    } finally {
      await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    }
  }

  private privateStorageRestartProofFile(): File {
    const privateDir = this.getPrivateObjectDir();
    const { bucketName, objectName: privatePrefix } = parseObjectPath(privateDir);
    const objectName = `${privatePrefix.replace(/\/$/, "")}/canaries/restart-proof-v1.json`;
    return objectStorageClient.bucket(bucketName).file(objectName);
  }

  /**
   * Seed the first half of a controlled restart proof. The marker is fixed,
   * synthetic and private; it contains only Railway runtime identity, a time
   * and a nonce. Repeating the seed in the same deployment is idempotent.
   */
  async seedPrivateStorageRestartProof(now = new Date()): Promise<PrivateStorageRestartSeedResult> {
    const runtime = runtimeDeploymentIdentity();
    const file = this.privateStorageRestartProofFile();
    const [exists] = await file.exists();
    if (exists) {
      const [existingBytes] = await file.download({ validation: "crc32c" });
      let existing: PrivateStorageRestartMarker | null = null;
      try {
        existing = parsePrivateStorageRestartMarker(existingBytes, now.getTime());
      } catch (error) {
        if (
          error instanceof PrivateStorageRestartProofError &&
          ["marker_expired", "marker_invalid"].includes(error.code)
        ) {
          await file.delete({ ignoreNotFound: true });
        } else {
          throw error;
        }
      }
      if (existing) {
        if (
          existing.sourceDeploymentId === runtime.deploymentId &&
          existing.sourceCommitSha === runtime.commitSha
        ) {
          return {
            status: "seeded",
            sourceCommitSha: existing.sourceCommitSha,
            seededAt: existing.seededAt,
            reused: true,
          };
        }
        throw new PrivateStorageRestartProofError("proof_in_progress");
      }
    }

    const marker: PrivateStorageRestartMarker = {
      version: 1,
      sourceDeploymentId: runtime.deploymentId,
      sourceCommitSha: runtime.commitSha,
      seededAt: now.toISOString(),
      nonce: randomUUID(),
    };
    await file.save(Buffer.from(JSON.stringify(marker), "utf8"), {
      contentType: "application/json",
      resumable: false,
      validation: "crc32c",
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { cacheControl: "private, no-store" },
    });
    return {
      status: "seeded",
      sourceCommitSha: marker.sourceCommitSha,
      seededAt: marker.seededAt,
      reused: false,
    };
  }

  /**
   * Complete a restart proof from a different Railway deployment running the
   * same commit. Successful verification removes the synthetic marker. A call
   * made before the restart leaves it in place and fails closed.
   */
  async verifyPrivateStorageRestartProof(
    now = new Date(),
  ): Promise<PrivateStorageRestartVerifyResult> {
    const runtime = runtimeDeploymentIdentity();
    const file = this.privateStorageRestartProofFile();
    const [exists] = await file.exists();
    if (!exists) throw new PrivateStorageRestartProofError("proof_missing");
    const [bytes] = await file.download({ validation: "crc32c" });
    const marker = parsePrivateStorageRestartMarker(bytes, now.getTime());
    const proof = validatePrivateStorageRestartTransition(marker, runtime, now);
    await file.delete({ ignoreNotFound: false });
    return proof;
  }

  /**
   * Store a normalized page produced by the server. The flat UUID path keeps
   * it compatible with the existing private `/objects/:id` resolver. Derived
   * pages inherit the borrower's private ACL and are never made public.
   */
  async savePrivateDerivedObject(
    bytes: Buffer,
    contentType: string,
    ownerUserId: string,
  ): Promise<string> {
    const privateDir = this.getPrivateObjectDir();
    const { bucketName, objectName: privatePrefix } = parseObjectPath(privateDir);
    const objectId = randomUUID();
    const objectName = `${privatePrefix.replace(/\/$/, "")}/${objectId}`;
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    try {
      await file.save(bytes, {
        contentType,
        resumable: false,
        validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { cacheControl: "private, max-age=3600" },
      });
      await setObjectAclPolicy(file, { owner: ownerUserId, visibility: "private" });
      return `/objects/${objectId}`;
    } catch (error) {
      await file.delete({ ignoreNotFound: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Best-effort cleanup used when page metadata cannot be committed. */
  async deleteObjectEntity(objectPath: string): Promise<void> {
    if (!objectPath.startsWith("/objects/")) return;
    try {
      const file = await this.getObjectEntityFile(objectPath);
      await file.delete({ ignoreNotFound: true });
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
  }

  /**
   * Verify a client-supplied /objects/ path before we trust it as a document:
   *  - the object must actually exist (you can't register a file you never
   *    uploaded), and
   *  - it must be unclaimed OR already owned by this user — otherwise this is
   *    an attempt to register someone else's object (IDOR). First registrant
   *    wins and becomes the ACL owner; a later claimant is rejected.
   *
   * Also returns the object's true content-type and size from storage metadata
   * so the caller can validate against the allow-list rather than trusting the
   * client-declared MIME/size (magic-byte parity for the JSON upload path).
   *
   * When storage is unconfigured (e.g. local dev without GCS) it reports
   * `configured: false` and does nothing — the caller decides whether to
   * fail open (dev) or closed (prod).
   */
  async verifyAndClaimObject(
    objectPath: string,
    userId: string,
  ): Promise<
    | { configured: false }
    | { configured: true; ok: false; reason: string }
    | { configured: true; ok: true; contentType?: string; size?: number }
  > {
    if (!this.isConfigured()) return { configured: false };

    let objectFile: File;
    try {
      objectFile = await this.getObjectEntityFile(objectPath);
    } catch {
      return { configured: true, ok: false, reason: "The uploaded file could not be found in storage." };
    }

    const [exists] = await objectFile.exists();
    if (!exists) {
      return { configured: true, ok: false, reason: "The uploaded file could not be found in storage." };
    }

    const existingPolicy = await getObjectAclPolicy(objectFile);
    if (existingPolicy && existingPolicy.owner && existingPolicy.owner !== userId) {
      return { configured: true, ok: false, reason: "You do not own this uploaded file." };
    }
    if (!existingPolicy) {
      await setObjectAclPolicy(objectFile, { owner: userId, visibility: "private" });
    }

    const [metadata] = await objectFile.getMetadata();
    const size = metadata?.size ? Number(metadata.size) : undefined;
    return { configured: true, ok: true, contentType: metadata?.contentType, size };
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
  contentType,
  extensionHeaders,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
  contentType?: string;
  extensionHeaders?: Record<string, string>;
}): Promise<string> {
  const actionForMethod = {
    GET: "read",
    PUT: "write",
    DELETE: "delete",
    HEAD: "read",
  } as const;

  const [signedURL] = await objectStorageClient
    .bucket(bucketName)
    .file(objectName)
    .getSignedUrl({
      version: "v4",
      action: actionForMethod[method],
      expires: Date.now() + ttlSec * 1000,
      ...(contentType ? { contentType } : {}),
      ...(extensionHeaders ? { extensionHeaders } : {}),
    });
  return signedURL;
}
