import fs from "fs";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import type { Response } from "express";

/**
 * Local filesystem fallback for the object-storage upload flow.
 *
 * When a GCS bucket is configured (PRIVATE_OBJECT_DIR set), uploads use the
 * real presigned-URL → Cloud Storage path. When it is NOT configured — i.e.
 * local development without cloud credentials — this shim lets the exact same
 * client flow (request-url → PUT bytes → register metadata → download) work
 * against a local temp directory, so document upload is testable without GCS.
 *
 * This is DEV-ONLY on purpose. It is never a substitute for GCS in production:
 * serverless disks are ephemeral (files vanish on redeploy — the very bug the
 * GCS path fixes). Every caller guards on isLocalFallbackEnabled(), and the
 * local PUT receiver 404s once storage is configured or in production.
 */

export function isObjectStorageConfigured(): boolean {
  return Boolean(process.env.PRIVATE_OBJECT_DIR);
}

/**
 * Whether the local filesystem fallback may be used. It is DEV-ONLY: in
 * production we never silently store uploads on ephemeral disk (that is the
 * exact "uploads succeed then vanish on redeploy" bug this whole flow fixes).
 * If a production deploy has no GCS bucket configured, uploads refuse loudly
 * (503) so the misconfiguration is obvious rather than quietly lossy.
 */
export function isLocalFallbackEnabled(): boolean {
  return !isObjectStorageConfigured() && process.env.NODE_ENV !== "production";
}

// Object ids are server-generated UUIDs. Validating the shape defeats path
// traversal on the one endpoint that takes an id from the client (the PUT).
const OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localDir(): string {
  const dir = path.join(os.tmpdir(), "homiquity-local-objects");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function objectIdFromPath(objectPath: string): string | null {
  if (!objectPath.startsWith("/objects/")) return null;
  const id = objectPath.slice("/objects/".length);
  return OBJECT_ID_RE.test(id) ? id : null;
}

/** Mint a local upload target mirroring the shape of the presigned response. */
export function createLocalUpload(): { uploadURL: string; objectPath: string } {
  const objectId = randomUUID();
  return {
    uploadURL: `/api/uploads/local/${objectId}`,
    objectPath: `/objects/${objectId}`,
  };
}

export function isValidObjectId(objectId: string): boolean {
  return OBJECT_ID_RE.test(objectId);
}

export function localObjectExists(objectPath: string): boolean {
  const id = objectIdFromPath(objectPath);
  if (!id) return false;
  return fs.existsSync(path.join(localDir(), id));
}

/** Hash the bytes that the local presigned-upload substitute actually stored. */
export function sha256LocalObject(objectPath: string): string | null {
  const id = objectIdFromPath(objectPath);
  if (!id) return null;
  const filePath = path.join(localDir(), id);
  if (!fs.existsSync(filePath)) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Read private bytes for server-side extraction/page processing in dev. */
export function readLocalObject(objectPath: string): Buffer {
  const id = objectIdFromPath(objectPath);
  if (!id) throw new Error("Invalid local object path");
  const filePath = path.join(localDir(), id);
  if (!fs.existsSync(filePath)) throw new Error("Local object not found");
  return fs.readFileSync(filePath);
}

export function writeLocalObject(objectId: string, buf: Buffer): void {
  if (!OBJECT_ID_RE.test(objectId)) {
    throw new Error("Invalid object id");
  }
  fs.writeFileSync(path.join(localDir(), objectId), buf);
}

/** Store server-derived bytes in the same dev-only private object area. */
export function writeLocalDerivedObject(buf: Buffer): string {
  const objectId = randomUUID();
  writeLocalObject(objectId, buf);
  return `/objects/${objectId}`;
}

/** Remove a server-derived local object after a failed database commit. */
export function deleteLocalObject(objectPath: string): void {
  const id = objectIdFromPath(objectPath);
  if (!id) return;
  fs.rmSync(path.join(localDir(), id), { force: true });
}

/** Streams a stored object to the response, or 404s. Caller does auth first. */
export function streamLocalObject(objectPath: string, res: Response): void {
  const id = objectIdFromPath(objectPath);
  if (!id) {
    res.status(404).json({ error: "Object not found" });
    return;
  }
  const filePath = path.join(localDir(), id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Object not found" });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  // Defense in depth: the raw /objects/ path streams without Content-Disposition,
  // so forbid MIME sniffing. Content is already allowlisted to PDF/image/doc at
  // upload, but this stops any sniff-to-render path outright.
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(filePath).pipe(res);
}
