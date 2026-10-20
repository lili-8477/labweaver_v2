// Imported originals (upload API v1.1): a clip or photo the wearer tagged in
// Photos arrives unchanged as one recording with source 'meta-ai', split
// into orig-NNN-cKKKK.bin chunks. On complete the chunks are joined, in the
// order the manifest lists them, back into orig-NNN.<ext> and checked against
// the manifest's bytes and sha256. Same steps as join_originals in
// server/reference_receiver.py (lili-8477/labweaver-glasses).

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import * as path from "node:path";
import { z } from "zod";

export const CHUNK_RE    = /^orig-(\d{3})-c(\d{4})\.bin$/;
export const ORIGINAL_RE = /^orig-(\d{3})\.(mp4|mov|jpg|jpeg|heic|png)$/;

export const MediaType = z.enum(["video", "photo"]);

export const Original = z.object({
  index:  z.number().int().min(1).max(999),
  file:   z.string().regex(ORIGINAL_RE),
  type:   MediaType,
  bytes:  z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  chunks: z.array(z.string().regex(CHUNK_RE)).min(1),
}).passthrough().refine(
  // orig-NNN.ext and its chunks orig-NNN-cKKKK.bin all carry the index.
  (o) => [o.file, ...o.chunks].every((f) => Number(f.slice(5, 8)) === o.index),
  { message: "file and chunks must carry the original's index" },
);

export type Original = z.infer<typeof Original>;

/** The originals of a stored import manifest ([] for a stream recording). */
export function originalsOf(manifest: unknown): Original[] {
  const parsed = z.object({ originals: z.array(Original) }).safeParse(manifest);
  return parsed.success ? parsed.data.originals : [];
}

/**
 * Joins the original's chunks into <dir>/<file>. Returns false, leaving no
 * file, when the result does not match the manifest's bytes and sha256.
 */
export async function joinOriginal(dir: string, original: Original): Promise<boolean> {
  const final = path.join(dir, original.file);
  const tmp = path.join(dir, `.${original.file}.${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    await pipeline(async function* () {
      for (const chunk of original.chunks) {
        for await (const buf of createReadStream(path.join(dir, chunk))) {
          hash.update(buf as Buffer);
          bytes += (buf as Buffer).length;
          yield buf;
        }
      }
    }, createWriteStream(tmp));
    if (bytes !== original.bytes || hash.digest("hex") !== original.sha256) return false;
    await rename(tmp, final);
    return true;
  } finally {
    await unlink(tmp).catch(() => {});   // no-op once renamed
  }
}
