import * as vscode from "vscode";
import type { GetBlob } from "./client";

export const BLOB_SCHEME = "vertra-blob";

/** Read-only view of an object. The authority is the object id; the path is only for the editor tab title. */
export class BlobFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(
    private readonly getBlob: GetBlob,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  dispose(): void {
    this.emitter.dispose();
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (!uri.authority) {return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };}
    try {
      const object = await (await this.getBlob()).get(uri.authority);
      const mtime = Date.parse(object.updated_at);
      return {
        type: vscode.FileType.File,
        ctime: Date.parse(object.created_at) || 0,
        mtime: Number.isFinite(mtime) ? mtime : 0,
        size: object.size,
      };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  readDirectory(): Array<[string, vscode.FileType]> {
    return [];
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const { url } = await (await this.getBlob()).downloadUrl(uri.authority, { expiresIn: 60 });
      const response = await this.fetchImpl(url);
      if (!response.ok) {throw new Error(String(response.status));}
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw vscode.FileSystemError.Unavailable(uri);
    }
  }

  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }
}
