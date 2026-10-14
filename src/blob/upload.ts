import * as vscode from "vscode";
import type { BlobApi } from "./client";
import { errorCodeOf } from "./errors";

export interface UploadEntry {
  uri: vscode.Uri;
  /** Path relative to the dropped item, using the dropped item's own name as the first segment. */
  rel: string;
}

export interface UploadSummary {
  uploaded: number;
  skipped: number;
  failed: number;
  firstError?: unknown;
}

function baseName(uri: vscode.Uri): string {
  return uri.path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** Expands folders recursively. Nothing is filtered: what the user picked is what is sent. */
export async function collectEntries(uris: vscode.Uri[]): Promise<UploadEntry[]> {
  const out: UploadEntry[] = [];
  const walk = async (uri: vscode.Uri, rel: string): Promise<void> => {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      for (const [name] of await vscode.workspace.fs.readDirectory(uri)) {
        await walk(vscode.Uri.joinPath(uri, name), `${rel}/${name}`);
      }
    } else {
      out.push({ uri, rel });
    }
  };
  for (const uri of uris) {await walk(uri, baseName(uri));}
  return out;
}

/**
 * Sends the files one after the other (the SDK already parallelises parts of big files).
 * An existing path is skipped, never overwritten. Stops at the first abort.
 */
export async function uploadEntries(
  blob: BlobApi,
  entries: UploadEntry[],
  prefix: string,
  signal: AbortSignal,
  onFile?: (entry: UploadEntry, done: number) => void,
): Promise<UploadSummary> {
  const summary: UploadSummary = { uploaded: 0, skipped: 0, failed: 0 };
  let done = 0;
  for (const entry of entries) {
    if (signal.aborted) {break;}
    onFile?.(entry, done++);
    try {
      // Reads the whole file into memory; large uploads from the editor would need a stream.
      const bytes = await vscode.workspace.fs.readFile(entry.uri);
      await blob.put(`${prefix}${entry.rel}`, bytes, { signal });
      summary.uploaded++;
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "ABORTED") {break;}
      if (code === "BLOB_OBJECT_ALREADY_EXISTS") {
        summary.skipped++;
      } else {
        summary.failed++;
        summary.firstError ??= error;
      }
    }
  }
  return summary;
}
