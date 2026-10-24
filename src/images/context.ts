import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ApiError } from "../api/client";
import { createZip, MAX_UPLOAD_BYTES, type CollectedFile, type CreatedZip } from "../deploy/zip";

/** Limites do contexto de build (guia público de imagens): 100 MB enviados, 512 MB e 50.000 entradas sem comprimir, Dockerfile até 1 MB. */
export const IMAGE_CONTEXT_MAX_ZIP_BYTES = MAX_UPLOAD_BYTES;
export const IMAGE_CONTEXT_MAX_BYTES = 512 * 1024 * 1024;
export const IMAGE_CONTEXT_MAX_ENTRIES = 50_000;
export const DOCKERFILE_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// .dockerignore (mesma semântica da CLI: o último padrão que casa vence, um padrão que casa um
// diretório casa tudo abaixo dele, `!` reinclui, `*` não cruza `/` e `**` cruza).

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
}

export interface DockerignoreSet {
  rules: IgnoreRule[];
  negates: boolean;
}

function quoteMeta(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegexp(pattern: string): string {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    switch (c) {
      case "*":
        if (pattern[i + 1] === "*") {
          i++;
          if (pattern[i + 1] === "/") {
            i++;
            out += "(.*/)?";
          } else {
            out += ".*";
          }
        } else {
          out += "[^/]*";
        }
        break;
      case "?":
        out += "[^/]";
        break;
      case "\\":
        if (i + 1 < pattern.length) {
          i++;
          out += quoteMeta(pattern[i]);
        }
        break;
      case "[": {
        const end = pattern.indexOf("]", i);
        if (end <= i + 1) {
          out += "\\[";
          break;
        }
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith("!")) {cls = `^${cls.slice(1)}`;}
        out += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = end;
        break;
      }
      default:
        out += quoteMeta(c);
    }
  }
  return `${out}$`;
}

function cleanPattern(line: string): string {
  let cleaned = path.posix.normalize(`/${line}`);
  while (cleaned.length > 1 && cleaned.endsWith("/")) {cleaned = cleaned.slice(0, -1);}
  return cleaned.slice(1);
}

export function parseDockerignore(content: string): DockerignoreSet {
  const set: DockerignoreSet = { rules: [], negates: false };
  for (const raw of content.replace(/\r\n/g, "\n").split("\n")) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) {continue;}
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1).trim();
    }
    line = cleanPattern(line);
    if (line === "" || line === ".") {continue;}
    let re: RegExp;
    try {
      re = new RegExp(globToRegexp(line));
    } catch {
      continue; // linha malformada: o Docker recusa o build; aqui ela só é ignorada
    }
    set.rules.push({ re, negate });
    set.negates = set.negates || negate;
  }
  return set;
}

/** `rel` usa `/` e é relativo à raiz do contexto. */
export function isDockerignored(set: DockerignoreSet, rel: string): boolean {
  let excluded = false;
  for (const rule of set.rules) {
    // Uma linha `!` só vale enquanto excluído; uma linha comum, só enquanto incluído.
    if (rule.negate !== excluded) {continue;}
    for (let p = rel; p !== "." && p !== ""; p = path.posix.dirname(p)) {
      if (rule.re.test(p)) {
        excluded = !rule.negate;
        break;
      }
    }
  }
  return excluded;
}

// ---------------------------------------------------------------------------

export interface ImageContext {
  root: string;
  /** O que vai no zip: `.env*` e symlinks nunca entram. */
  files: CollectedFile[];
  /** Caminhos `.env*` encontrados e não excluídos pelo `.dockerignore`: só entram na checagem, para o aviso. */
  envFiles: string[];
  totalBytes: number;
  skippedSymlinks: number;
  /** Conteúdo do `Dockerfile` da raiz. */
  dockerfile: string;
}

export interface CollectImageContextOptions {
  token?: vscode.CancellationToken;
  maxEntries?: number;
  maxBytes?: number;
}

function tooLarge(message: string): ApiError {
  return new ApiError(0, "IMAGE_CONTEXT_TOO_LARGE", message, { local: true });
}

function dockerfileNotFound(): ApiError {
  return new ApiError(0, "DOCKERFILE_NOT_FOUND", "No file named exactly Dockerfile at the root of the context.");
}

function isEnvFile(name: string): boolean {
  return name.startsWith(".env");
}

/** O nome tem de ser exatamente `Dockerfile`: em disco sem diferença de caixa, `lstat` aceitaria `dockerfile`. */
async function readDockerfile(root: string): Promise<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const entry = entries.find((e) => e.name === "Dockerfile");
  if (!entry || !entry.isFile()) {throw dockerfileNotFound();}
  const abs = path.join(root, "Dockerfile");
  const stat = await fs.lstat(abs);
  if (!stat.isFile()) {throw dockerfileNotFound();}
  if (stat.size > DOCKERFILE_MAX_BYTES) {
    throw tooLarge(vscode.l10n.t("The Dockerfile is larger than 1 MB."));
  }
  return fs.readFile(abs, "utf8");
}

/**
 * Percorre a pasta como o `vertra image build` da CLI: respeita `.dockerignore`, mantém sempre o
 * `Dockerfile` da raiz, nunca inclui `.env*` nem symlinks.
 */
export async function collectImageContext(root: string, opts: CollectImageContextOptions = {}): Promise<ImageContext> {
  const dockerfile = await readDockerfile(root);
  let set: DockerignoreSet = { rules: [], negates: false };
  try {
    set = parseDockerignore(await fs.readFile(path.join(root, ".dockerignore"), "utf8"));
  } catch {
    // sem .dockerignore
  }
  const maxEntries = opts.maxEntries ?? IMAGE_CONTEXT_MAX_ENTRIES;
  const maxBytes = opts.maxBytes ?? IMAGE_CONTEXT_MAX_BYTES;
  const files: CollectedFile[] = [];
  const envFiles: string[] = [];
  const state = { totalBytes: 0, skippedSymlinks: 0 };

  const walk = async (dir: string): Promise<void> => {
    if (opts.token?.isCancellationRequested) {return;}
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (opts.token?.isCancellationRequested) {return;}
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (rel.startsWith("..") || path.isAbsolute(rel)) {continue;}

      if (entry.isSymbolicLink()) {
        state.skippedSymlinks++;
        continue;
      }
      // O yazl troca `\` por `/` no nome da entrada: `cfg\.env` viraria `cfg/.env` e `a\..\..\b` faria o empacotamento lançar.
      if (process.platform !== "win32" && entry.name.includes("\\")) {continue;}
      if (isEnvFile(entry.name)) {
        if (entry.isFile() && !isDockerignored(set, rel)) {envFiles.push(rel);}
        continue;
      }
      const keep = rel === "Dockerfile";
      if (entry.isDirectory()) {
        // Com alguma linha `!`, um diretório excluído pode ter filho reincluído: desce sempre.
        if (!keep && !set.negates && isDockerignored(set, rel)) {continue;}
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) {continue;}
      if (!keep && isDockerignored(set, rel)) {continue;}

      const stat = await fs.stat(abs);
      files.push({ abs, rel, size: stat.size });
      state.totalBytes += stat.size;
      if (files.length > maxEntries) {
        throw tooLarge(vscode.l10n.t("The project has more than {0} files. Use a .dockerignore to leave files out.", maxEntries));
      }
      if (state.totalBytes > maxBytes) {
        throw tooLarge(vscode.l10n.t("The project is over {0} MB uncompressed. Use a .dockerignore to leave files out.", Math.round(maxBytes / (1024 * 1024))));
      }
    }
  };
  await walk(root);

  return { root, files, envFiles, totalBytes: state.totalBytes, skippedSymlinks: state.skippedSymlinks, dockerfile };
}

/** `files` de `POST /v1/images/check`: o que vai no zip mais os `.env*` deixados de fora, para o aviso do servidor. */
export function contextFileList(ctx: ImageContext): string[] {
  return [...new Set([...ctx.files.map((f) => f.rel), ...ctx.envFiles])];
}

export function packImageContext(ctx: ImageContext, token?: vscode.CancellationToken): Promise<CreatedZip> {
  return createZip(ctx.files, {
    token,
    recheck: true,
    maxTotalBytes: IMAGE_CONTEXT_MAX_BYTES,
    tooLarge: (bytes, kind) =>
      tooLarge(
        kind === "zip"
          ? vscode.l10n.t("The compressed context is {0} MB, over the {1} MB limit. Use a .dockerignore to leave files out.", (bytes / (1024 * 1024)).toFixed(1), IMAGE_CONTEXT_MAX_ZIP_BYTES / (1024 * 1024))
          : vscode.l10n.t("The project is {0} MB uncompressed, over the {1} MB limit. Use a .dockerignore to leave files out.", (bytes / (1024 * 1024)).toFixed(1), IMAGE_CONTEXT_MAX_BYTES / (1024 * 1024)),
      ),
  });
}
