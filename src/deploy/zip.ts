import type { Ignore } from "ignore";
import { createWriteStream, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ZipFile } from "yazl";
import { ApiError } from "../api/client";
import { isIgnored } from "./ignore";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface CollectedFile {
  abs: string;
  rel: string;
  size: number;
}

export interface CollectFilesResult {
  files: CollectedFile[];
  totalBytes: number;
  skippedSymlinks: number;
}

export interface CollectFilesOptions {
  token?: vscode.CancellationToken;
  onProgress?(count: number, bytes: number): void;
}

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

async function walk(
  dir: string,
  root: string,
  ig: Ignore,
  out: CollectedFile[],
  state: { skippedSymlinks: number; totalBytes: number },
  opts: CollectFilesOptions,
): Promise<void> {
  if (opts.token?.isCancellationRequested) {return;}
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (opts.token?.isCancellationRequested) {return;}

    if (entry.isSymbolicLink()) {
      state.skippedSymlinks++;
      continue;
    }

    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {continue;}

    const relPosix = toPosix(rel);
    if (isIgnored(ig, relPosix, entry.isDirectory())) {continue;}

    if (entry.isDirectory()) {
      await walk(abs, root, ig, out, state, opts);
    } else if (entry.isFile()) {
      const stat = await fs.stat(abs);
      out.push({ abs, rel: relPosix, size: stat.size });
      state.totalBytes += stat.size;
      opts.onProgress?.(out.length, state.totalBytes);
    }
  }
}

export async function collectFiles(
  root: string,
  ig: Ignore,
  opts: CollectFilesOptions = {},
): Promise<CollectFilesResult> {
  const files: CollectedFile[] = [];
  const state = { skippedSymlinks: 0, totalBytes: 0 };
  await walk(root, root, ig, files, state, opts);
  return { files, totalBytes: state.totalBytes, skippedSymlinks: state.skippedSymlinks };
}

export interface CreateZipOptions {
  token?: vscode.CancellationToken;
  onProgress?(done: number, total: number): void;
}

export interface CreatedZip {
  path: string;
  size: number;
  cleanup(): Promise<void>;
}

function emptyProjectError(): ApiError {
  return new ApiError(0, "EMPTY_PROJECT", vscode.l10n.t("The project has no files to deploy."));
}

function fileTooLargeError(bytes: number): ApiError {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  const maxMb = (MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
  return new ApiError(
    0,
    "FILE_TOO_LARGE",
    vscode.l10n.t("Project is {0} MB, which is over the {1} MB upload limit.", mb, maxMb),
  );
}

async function rmTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export async function createZip(
  files: CollectedFile[],
  opts: CreateZipOptions = {},
): Promise<CreatedZip> {
  if (files.length === 0) {throw emptyProjectError();}

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) {throw fileTooLargeError(totalBytes);}

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertra-"));
  const zipPath = path.join(tmpDir, "deploy.zip");
  const cleanup = () => rmTempDir(tmpDir);

  if (opts.token?.isCancellationRequested) {
    await cleanup();
    throw new ApiError(0, "CANCELLED", "Zip creation cancelled");
  }

  const zipfile = new ZipFile();
  for (const file of files) {zipfile.addFile(file.abs, file.rel);}
  zipfile.end();

  const output = createWriteStream(zipPath);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) {return;}
      settled = true;
      subscription?.dispose();
      if (err) {reject(err);}
      else {resolve();}
    };

    const subscription = opts.token?.onCancellationRequested(() => {
      zipfile.outputStream.unpipe(output);
      (zipfile.outputStream as { destroy?(): void }).destroy?.();
      output.destroy();
      finish(new ApiError(0, "CANCELLED", "Zip creation cancelled"));
    });

    zipfile.outputStream.pipe(output);
    output.on("close", () => finish());
    output.on("error", (err) => finish(err));
    zipfile.outputStream.on("error", (err) => finish(err));

    let done = 0;
    zipfile.outputStream.on("data", (chunk: Buffer) => {
      done += chunk.length;
      opts.onProgress?.(done, totalBytes);
    });
  }).catch(async (err) => {
    await cleanup();
    throw err;
  });

  const stat = await fs.stat(zipPath);
  if (stat.size > MAX_UPLOAD_BYTES) {
    await cleanup();
    throw fileTooLargeError(stat.size);
  }

  return { path: zipPath, size: stat.size, cleanup };
}
