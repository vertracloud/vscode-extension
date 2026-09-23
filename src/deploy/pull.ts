import * as fs from "node:fs/promises";
import * as path from "node:path";
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

/** Writes every safe entry of the zip into `root`, leaving files that are not in the zip alone. */
export function extractInto(zipBuffer: Buffer, root: string): Promise<PullResult> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {return reject(openError ?? new Error("INVALID_ZIP"));}
      const result: PullResult = { written: 0, skipped: 0 };
      zip.on("error", reject);
      zip.on("end", () => resolve(result));
      zip.on("entry", (entry: yauzl.Entry) => {
        const target = safeTarget(root, entry.fileName);
        if (!target) {
          result.skipped++;
          return zip.readEntry();
        }
        if (entry.fileName.endsWith("/")) {
          fs.mkdir(target, { recursive: true }).then(() => zip.readEntry(), reject);
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {return reject(streamError ?? new Error("INVALID_ZIP"));}
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            fs.mkdir(path.dirname(target), { recursive: true })
              .then(() => fs.writeFile(target, Buffer.concat(chunks)))
              .then(() => {
                result.written++;
                zip.readEntry();
              }, reject);
          });
        });
      });
      zip.readEntry();
    });
  });
}
