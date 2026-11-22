import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { blobs } from "@/lib/db/schema";
import { open, seal, unwrapKey } from "@/lib/security/envelope";

/**
 * Encrypted blob storage for fragment inputs and outputs. Callers pass the
 * fragment's wrapped data key; the plaintext key exists only in memory for
 * the length of one call.
 */

type Tx = Pick<Db, "insert" | "select" | "delete">;

export function newBlobKey(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * What a fragment's data key is bound to (AAD for the key wrap): the job and
 * the piece number, so a wrapped key copied onto another row won't open.
 */
export function keyOwner(jobId: string, seq: number): string {
  return `${jobId}/${seq}`;
}

export async function putBlob(
  db: Tx,
  args: { dataKey: Buffer; jobId: string; key?: string; plaintext: Uint8Array },
): Promise<string> {
  const key = args.key ?? newBlobKey();
  const sealed = seal(args.dataKey, args.plaintext, `blob:${args.jobId}:${key}`);
  await db.insert(blobs).values({ key, jobId: args.jobId, data: sealed, bytes: args.plaintext.length });
  return key;
}

export async function getBlob(db: Tx, args: { dataKey: Buffer; jobId: string; key: string }): Promise<Buffer | null> {
  const [row] = await db
    .select({ data: blobs.data })
    .from(blobs)
    .where(and(eq(blobs.key, args.key), eq(blobs.jobId, args.jobId)))
    .limit(1);
  if (!row) return null;
  return open(args.dataKey, row.data, `blob:${args.jobId}:${args.key}`);
}

/** The data key of one fragment (all copies of a piece share it). */
export function fragmentDataKey(masterKey: Buffer, f: { jobId: string; seq: number; wrappedKey: string }): Buffer {
  return unwrapKey(masterKey, f.wrappedKey, keyOwner(f.jobId, f.seq));
}

export async function deleteJobBlobs(db: Tx, jobId: string): Promise<void> {
  await db.delete(blobs).where(eq(blobs.jobId, jobId));
}
