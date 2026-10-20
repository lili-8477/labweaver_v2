// file_manager.* RPCs — implement directly on the local filesystem.
// Paths resolve through workspace-path.ts (containment + access policy).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { isListed, workspacePath, type Access } from "./workspace-path.js";
import type { FileListing, FileManagerMethods } from "./rpc-contract.js";

type FileParams<M extends keyof FileManagerMethods> = FileManagerMethods[M]["params"];
type FileResult<M extends keyof FileManagerMethods> = FileManagerMethods[M]["result"];

// Extensions that are always binary. Everything else is read as UTF-8 text;
// if that decode produces replacement chars, we fall back to base64.
const BINARY_EXTS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "heic", "avif",
  // documents
  "pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp",
  // archives
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
  // media
  "mp4", "mov", "webm", "mkv", "avi", "mp3", "wav", "ogg", "flac", "m4a",
  // sci-data
  "h5", "hdf5", "h5ad", "rds", "feather", "arrow", "parquet", "npy", "npz", "pkl", "pickle", "mtx", "10x", "loom",
  // compiled
  "so", "dylib", "dll", "exe", "class", "jar",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
]);

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
  heic: "image/heic", avif: "image/avif",
  pdf: "application/pdf",
  json: "application/json", xml: "application/xml",
  csv: "text/csv", tsv: "text/tab-separated-values",
  html: "text/html", css: "text/css", txt: "text/plain",
  md: "text/markdown", log: "text/plain",
  py: "text/x-python", js: "application/javascript", ts: "application/typescript",
  sh: "application/x-sh", yaml: "application/yaml", yml: "application/yaml",
  r: "text/x-r", ipynb: "application/x-ipynb+json",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  zip: "application/zip", gz: "application/gzip",
};

function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] || "application/octet-stream";
}

export class FileManager {
  constructor(private root: string) {}

  private resolve(relPath: string, access: Access): string {
    return workspacePath(this.root, relPath, access);
  }

  async listFiles(relPath = ""): Promise<FileResult<"list_files">> {
    const abs = this.resolve(relPath, "read");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const out: FileListing[] = [];
    for (const e of entries) {
      if (!isListed(e.name)) continue;
      const entryPath = path.join(relPath, e.name);
      const full = path.join(abs, e.name);
      try {
        const st = await fs.stat(full);
        out.push({
          name: e.name,
          path: entryPath,
          type: e.isDirectory() ? "directory" : "file",
          size: e.isDirectory() ? undefined : st.size,
          modified: Math.floor(st.mtimeMs / 1000),
        });
      } catch {
        // skip unreadable
      }
    }
    return { success: true, files: out };
  }

  async readFile(relPath: string, opts: { encoding?: "utf8" | "base64" } = {}): Promise<FileResult<"read_file">> {
    const abs = this.resolve(relPath, "read");
    const ext = (relPath.split(".").pop() ?? "").toLowerCase();
    const mime = mimeForExt(ext);
    const wantBase64 = opts.encoding === "base64" || BINARY_EXTS.has(ext);

    // Guard against oversized reads: NATS caps payload at ~128 MB, and base64
    // adds 33%. Refuse early with a clear message instead of a cryptic NATS error.
    const st = await fs.stat(abs);
    const wireSize = wantBase64 ? st.size * 1.34 : st.size;
    const WIRE_LIMIT = 100 * 1024 * 1024; // leaves headroom under 128 MB
    if (wireSize > WIRE_LIMIT) {
      throw new Error(
        `file too large for in-browser transport: ${(st.size / 1024 / 1024).toFixed(1)} MB. ` +
          `Files above ~90 MB need 'docker cp' from the host to download.`,
      );
    }

    if (wantBase64) {
      const buf = await fs.readFile(abs);
      return {
        success: true,
        content: buf.toString("base64"),
        encoding: "base64",
        mime_type: mime,
        size: buf.length,
      };
    }

    // Try UTF-8; fall back to base64 if the decode produces replacement chars
    // (i.e. the file is actually binary with an unknown extension).
    const buf = await fs.readFile(abs);
    const text = buf.toString("utf8");
    if (text.includes("\uFFFD")) {
      return {
        success: true,
        content: buf.toString("base64"),
        encoding: "base64",
        mime_type: "application/octet-stream",
        size: buf.length,
      };
    }
    return { success: true, content: text, encoding: "utf8", mime_type: mime, size: buf.length };
  }

  async writeFile(
    relPath: string,
    content: string,
    opts: { encoding?: "utf8" | "base64" } = {},
  ): Promise<FileResult<"write_file">> {
    const abs = this.resolve(relPath, "write");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (opts.encoding === "base64") {
      await fs.writeFile(abs, Buffer.from(content, "base64"));
    } else {
      await fs.writeFile(abs, content, "utf8");
    }
    return { success: true };
  }

  async deleteFile(relPath: string): Promise<FileResult<"delete_file">> {
    const abs = this.resolve(relPath, "write");
    const st = await fs.stat(abs);
    if (st.isDirectory()) await fs.rm(abs, { recursive: true, force: true });
    else await fs.unlink(abs);
    return { success: true };
  }

  /** manage_path: create_dir | delete | move — used by the frontend's file CRUD. */
  async managePath(p: FileParams<"manage_path">): Promise<FileResult<"manage_path">> {
    if (p.operation === "create_dir") {
      const abs = this.resolve(p.path, "write");
      await fs.mkdir(abs, { recursive: true });
      return { success: true };
    }
    if (p.operation === "delete") {
      const abs = this.resolve(p.path, "write");
      try {
        const st = await fs.stat(abs);
        if (st.isDirectory()) await fs.rm(abs, { recursive: p.recursive ?? true, force: true });
        else await fs.unlink(abs);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      return { success: true };
    }
    if (p.operation === "move") {
      const { from, to } = p;
      if (!from || !to) throw new Error("manage_path move: missing from/to");

      const absFrom = this.resolve(from, "write");
      const absTo = this.resolve(to, "write");

      // Refuse if target already exists. No overwrite.
      try {
        await fs.stat(absTo);
        throw new Error("manage_path move: target_exists");
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }

      await fs.mkdir(path.dirname(absTo), { recursive: true });
      await fs.rename(absFrom, absTo);
      return { success: true };
    }
    throw new Error(`manage_path: unknown operation ${(p as { operation: unknown }).operation}`);
  }

  /** One handler per FileManagerMethods entry (rpc-contract.ts). */
  private readonly handlers: { [M in keyof FileManagerMethods]: (p: FileParams<M>) => Promise<FileResult<M>> } = {
    list_files:  (p) => this.listFiles(p.sub_dir ?? ""),
    read_file:   (p) => this.readFile(p.file_path, { encoding: p.encoding }),
    write_file:  (p) => this.writeFile(p.file_path, p.content ?? "", { encoding: p.encoding }),
    delete_file: (p) => this.deleteFile(p.file_path),
    manage_path: (p) => this.managePath(p),
  };

  async dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (!Object.hasOwn(this.handlers, method)) throw new Error(`file_manager: unknown method ${method}`);
    const handler = this.handlers[method as keyof FileManagerMethods] as (p: unknown) => Promise<unknown>;
    return handler(args);
  }
}
