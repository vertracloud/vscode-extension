import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { DEFAULT_IGNORE } from "./ignore";

export interface PullResult {
  written: number;
  skipped: number;
}

// `vertracloud.config` guarda o vínculo local (`ID=`) e `.vertracloud` são logs da plataforma:
// nenhum dos dois é código do projeto.
const skippedRoots = new Set([...DEFAULT_IGNORE, "vertracloud.config", ".vertracloud"]);

function safeTarget(root: string, entryName: string): string | undefined {
  const rel = entryName.replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("/") || rel.includes("\0")) {return undefined;}
  const parts = rel.split("/");
  if (parts.some((part) => part === "..")) {return undefined;}
  if (skippedRoots.has(parts[0])) {return undefined;}
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {return undefined;}
  return target;
}

function extractZip(
  open: (callback: (error: Error | null, zip?: yauzl.ZipFile) => void) => void,
  root: string,
): Promise<PullResult> {
  return new Promise((resolve, reject) => {
    open((openError, zip) => {
      if (openError || !zip) {return reject(openError ?? new Error("INVALID_ZIP"));}
      const result: PullResult = { written: 0, skipped: 0 };
      const fail = (error: Error): void => {
        zip.close();
        reject(error);
      };
      zip.on("error", fail);
      zip.on("end", () => resolve(result));
      zip.on("entry", (entry: yauzl.Entry) => {
        const target = safeTarget(root, entry.fileName);
        if (!target) {
          result.skipped++;
          return zip.readEntry();
        }
        if (entry.fileName.endsWith("/")) {
          fs.mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail);
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {return fail(streamError ?? new Error("INVALID_ZIP"));}
          // Cada arquivo vai do zip ao disco em fluxo: um arquivo grande não passa inteiro pela memória.
          fs.mkdir(path.dirname(target), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(target)))
            .then(() => {
              result.written++;
              zip.readEntry();
            }, fail);
        });
      });
      zip.readEntry();
    });
  });
}

/** Writes every safe entry of the zip into `root`, leaving files that are not in the zip alone. */
export function extractInto(zipBuffer: Buffer, root: string): Promise<PullResult> {
  return extractZip((callback) => yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, callback), root);
}

/** Same as `extractInto`, reading the zip from a file on disk: the zip itself never sits in memory. */
export function extractFileInto(zipPath: string, root: string): Promise<PullResult> {
  return extractZip((callback) => yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, callback), root);
}
