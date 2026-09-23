import * as vscode from "vscode";
import type { APIApplicationFile, APIApplicationFileTree } from "@vertracloud/api-types/v1";
import type { ApiClient } from "./api/client";
import * as files from "./api/files";
import { describeError, type ApiErrorLike } from "./l10n";

export const VERTRA_SCHEME = "vertra";

/**
 * A API limita a listagem a poucas chamadas por minuto, e o Explorer pede um `stat` por item.
 * Uma árvore inteira por app preenche o cache de todas as pastas de uma vez; pedidos
 * concorrentes pela mesma pasta compartilham a mesma requisição.
 */
const DIR_CACHE_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 10_000;

interface CachedDir {
  at: number;
  entries: APIApplicationFile[];
}

function errorLike(err: unknown): ApiErrorLike & { status?: number } {
  if (err && typeof err === "object" && "code" in err) {
    return err as ApiErrorLike & { status?: number };
  }
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) };
}

/** Caminho POSIX relativo à raiz do app. `..` nunca chega à API. */
function remotePath(uri: vscode.Uri): string {
  const normalized = uri.path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (normalized.includes("\0")) {throw vscode.FileSystemError.FileNotFound(uri);}
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw vscode.FileSystemError.FileNotFound(uri);
  }
  return normalized;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function nameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

export class VertraFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  private readonly dirs = new Map<string, CachedDir>();
  private readonly inflight = new Map<string, Promise<APIApplicationFile[]>>();
  private readonly treeLoaded = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly mtimes = new Map<string, string>();
  private readonly names = new Map<string, string>();

  constructor(private readonly client: ApiClient) {}

  /** Rótulo da pasta no Explorer; sem isso a raiz apareceria com o id. */
  rememberApp(appId: string, name: string): void {
    this.names.set(appId, name);
  }

  appName(appId: string): string | undefined {
    return this.names.get(appId);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const path = remotePath(uri);
    if (path === "") {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const entries = await this.list(uri.authority, parentOf(path), uri);
    const entry = entries.find((item) => item.name === nameOf(path));
    if (!entry) {throw vscode.FileSystemError.FileNotFound(uri);}
    const mtime = Date.parse(entry.last_modified);
    if (entry.type !== "directory") {this.mtimes.set(this.key(uri.authority, path), entry.last_modified);}
    return {
      type: entry.type === "directory" ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: Number.isFinite(mtime) ? mtime : 0,
      size: 0,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> {
    const entries = await this.list(uri.authority, remotePath(uri), uri);
    return entries.map((entry) => [
      entry.name,
      entry.type === "directory" ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const path = remotePath(uri);
    try {
      const content = await files.readFile(this.client, uri.authority, path);
      if (content.lastModified) {this.mtimes.set(this.key(uri.authority, path), content.lastModified);}
      return content.bytes;
    } catch (error) {
      throw this.toFsError(error, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    this.requireTrust(uri);
    const path = remotePath(uri);
    const existing = await this.statOrUndefined(uri);
    if (!existing && !options.create) {throw vscode.FileSystemError.FileNotFound(uri);}
    if (existing && !options.overwrite) {throw vscode.FileSystemError.FileExists(uri);}

    try {
      await files.writeFile(
        this.client,
        uri.authority,
        path,
        content,
        existing ? this.mtimes.get(this.key(uri.authority, path)) : undefined,
      );
    } catch (error) {
      throw this.toFsError(error, uri);
    }
    // O `last_modified` novo não volta no PUT: esquecer é mais seguro que guardar o antigo,
    // que dispararia um conflito falso na próxima gravação.
    this.mtimes.delete(this.key(uri.authority, path));
    this.invalidate(uri.authority, parentOf(path));
    this.fire(existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    this.requireTrust(uri);
    const path = remotePath(uri);
    try {
      await files.createDirectory(this.client, uri.authority, path);
    } catch (error) {
      throw this.toFsError(error, uri);
    }
    this.invalidate(uri.authority, parentOf(path));
    this.fire(vscode.FileChangeType.Created, uri);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    this.requireTrust(uri);
    const path = remotePath(uri);
    const existing = await this.statOrUndefined(uri);
    if (existing?.type === vscode.FileType.Directory && !options.recursive) {
      throw vscode.FileSystemError.NoPermissions(
        vscode.l10n.t("Deleting a folder on Vertra Cloud removes everything inside it."),
      );
    }
    try {
      await files.deleteFile(this.client, uri.authority, path);
    } catch (error) {
      throw this.toFsError(error, uri);
    }
    this.mtimes.delete(this.key(uri.authority, path));
    this.invalidate(uri.authority, parentOf(path));
    this.fire(vscode.FileChangeType.Deleted, uri);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    this.requireTrust(oldUri);
    const from = remotePath(oldUri);
    const to = remotePath(newUri);
    if (!options.overwrite && (await this.statOrUndefined(newUri))) {
      throw vscode.FileSystemError.FileExists(newUri);
    }
    try {
      await files.moveFile(this.client, oldUri.authority, from, to);
    } catch (error) {
      throw this.toFsError(error, oldUri);
    }
    this.mtimes.delete(this.key(oldUri.authority, from));
    this.invalidate(oldUri.authority, parentOf(from));
    this.invalidate(newUri.authority, parentOf(to));
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  copy(source: vscode.Uri): void {
    throw vscode.FileSystemError.Unavailable(
      vscode.l10n.t("Copying files inside Vertra Cloud isn't supported. Download and upload instead.") +
        ` (${source.path})`,
    );
  }

  dispose(): void {
    this.emitter.dispose();
    this.dirs.clear();
    this.inflight.clear();
    this.treeLoaded.clear();
    this.mtimes.clear();
  }

  private key(appId: string, path: string): string {
    return `${appId}:${path}`;
  }

  private async list(
    appId: string,
    path: string,
    uri: vscode.Uri,
  ): Promise<APIApplicationFile[]> {
    const key = this.key(appId, path);
    const cached = this.dirs.get(key);
    if (cached && Date.now() - cached.at < DIR_CACHE_MS) {return cached.entries;}
    if (cached && Date.now() < (this.cooldownUntil.get(appId) ?? 0)) {return cached.entries;}

    const pending = this.inflight.get(key);
    if (pending) {return pending;}
    const request = this.fetchDir(appId, path)
      .catch((error) => {
        const err = errorLike(error);
        if (err.code === "RATE_LIMIT_EXCEEDED" || err.status === 429) {
          const wait = (err.retryAfter ?? RATE_LIMIT_COOLDOWN_MS / 1000) * 1000;
          this.cooldownUntil.set(appId, Date.now() + wait);
          if (cached) {return cached.entries;}
        }
        throw this.toFsError(error, uri);
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private async fetchDir(appId: string, path: string): Promise<APIApplicationFile[]> {
    if (!this.treeLoaded.has(appId)) {
      this.treeLoaded.add(appId);
      const tree = await files.listTree(this.client, appId).catch(() => undefined);
      if (tree && Array.isArray(tree.children)) {
        this.storeTree(appId, "", tree.children);
        const fromTree = this.dirs.get(this.key(appId, path));
        if (fromTree) {return fromTree.entries;}
      }
    }
    const entries = await files.listFiles(this.client, appId, path);
    this.dirs.set(this.key(appId, path), { at: Date.now(), entries });
    return entries;
  }

  private storeTree(appId: string, dir: string, children: APIApplicationFileTree[]): void {
    const at = Date.now();
    this.dirs.set(this.key(appId, dir), { at, entries: children });
    for (const child of children) {
      if (child.type === "directory") {
        this.storeTree(appId, dir ? `${dir}/${child.name}` : child.name, child.children ?? []);
      }
    }
  }

  /** Depois de um deploy ou restore o volume inteiro mudou; o Explorer relê a raiz. */
  invalidateApp(appId: string): void {
    for (const key of this.dirs.keys()) {
      if (key.startsWith(`${appId}:`)) {this.dirs.delete(key);}
    }
    for (const key of this.mtimes.keys()) {
      if (key.startsWith(`${appId}:`)) {this.mtimes.delete(key);}
    }
    this.treeLoaded.delete(appId);
    this.fire(vscode.FileChangeType.Changed, remoteUri(appId));
  }

  private invalidate(appId: string, path: string): void {
    this.dirs.delete(this.key(appId, path));
  }

  private async statOrUndefined(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
    try {
      return await this.stat(uri);
    } catch {
      return undefined;
    }
  }

  private requireTrust(uri: vscode.Uri): void {
    if (!vscode.workspace.isTrusted) {
      throw vscode.FileSystemError.NoPermissions(
        vscode.l10n.t("Trust this workspace to change files on Vertra Cloud.") + ` (${uri.path})`,
      );
    }
  }

  private fire(type: vscode.FileChangeType, uri: vscode.Uri): void {
    this.emitter.fire([{ type, uri }]);
  }

  private toFsError(error: unknown, uri: vscode.Uri): Error {
    const err = errorLike(error);
    const message = describeError(err);
    switch (err.code) {
      case "FILE_MODIFIED":
        return new vscode.FileSystemError(
          vscode.l10n.t("The file changed on Vertra Cloud since it was opened. Reload it before saving."),
        );
      case "FILE_NOT_TEXT":
        return new vscode.FileSystemError(
          vscode.l10n.t("Only UTF-8 text files can be saved to Vertra Cloud. This file is binary."),
        );
      case "TARGET_IS_DIRECTORY":
        return vscode.FileSystemError.FileIsADirectory(uri);
      case "FILE_NOT_FOUND":
      case "FILE_OR_FOLDER_NOT_FOUND":
      case "APP_NOT_FOUND":
        return vscode.FileSystemError.FileNotFound(uri);
      default:
        break;
    }
    if (err.code.startsWith("PLAN_") || err.code === "API_KEY_SCOPE_DENIED") {
      return vscode.FileSystemError.NoPermissions(message);
    }
    if (err.status === 404) {return vscode.FileSystemError.FileNotFound(uri);}
    if (err.status === 401 || err.status === 403) {
      return vscode.FileSystemError.NoPermissions(message);
    }
    return vscode.FileSystemError.Unavailable(message);
  }
}

export function remoteUri(appId: string, path = ""): vscode.Uri {
  return vscode.Uri.from({ scheme: VERTRA_SCHEME, authority: appId, path: `/${path}` });
}
