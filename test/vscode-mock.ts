export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}

export class TreeItem {
  public iconPath?: ThemeIcon;
  public command?: unknown;
  public description?: string;
  public tooltip?: unknown;
  public contextValue?: string;
  constructor(public label: string, public collapsibleState?: TreeItemCollapsibleState) {}
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data?: T): void {
    for (const listener of this.listeners) {listener(data as T);}
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  private constructor(public scheme: string, public path: string, public authority = "") {}
  static parse(value: string): Uri {
    return new Uri("parsed", value);
  }
  static file(value: string): Uri {
    return new Uri("file", value);
  }
  static from(parts: { scheme: string; authority?: string; path?: string }): Uri {
    return new Uri(parts.scheme, parts.path ?? "", parts.authority ?? "");
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path, ...segments].join("/").replace(/\/+/g, "/");
    return new Uri(base.scheme, joined, base.authority);
  }
  with(parts: { path?: string; authority?: string }): Uri {
    return new Uri(this.scheme, parts.path ?? this.path, parts.authority ?? this.authority);
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return this.authority ? `${this.scheme}://${this.authority}${this.path}` : this.path;
  }
}

export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

class FakeSecretStorage {
  private data = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export interface Progress<T> {
  report(value: T): void;
}

export interface FakeTreeView {
  message?: string;
  visible: boolean;
  onDidChangeVisibility: EventEmitter<{ visible: boolean }>["event"];
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createFakeTreeView(_viewId: string, _options: unknown): FakeTreeView {
  const emitter = new EventEmitter<{ visible: boolean }>();
  const view: FakeTreeView = {
    message: undefined,
    visible: true,
    onDidChangeVisibility: emitter.event,
    setVisible(visible: boolean) {
      view.visible = visible;
      emitter.fire({ visible });
    },
    dispose: () => emitter.dispose(),
  };
  return view;
}

const windowStateEmitter = new EventEmitter<{ focused: boolean }>();

export const openedTextDocuments: Array<{ uri?: Uri; content?: string; languageId?: string }> = [];

export const window = {
  showTextDocument: (..._args: unknown[]) => Promise.resolve(undefined),
  registerTreeDataProvider: (..._args: unknown[]) => ({ dispose: () => {} }),
  createTreeView: (viewId: string, options: unknown) => createFakeTreeView(viewId, options),
  showInformationMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showWarningMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showErrorMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showInputBox: (..._args: unknown[]) => Promise.resolve(undefined),
  showQuickPick: (..._args: unknown[]) => Promise.resolve(undefined),
  showOpenDialog: (..._args: unknown[]) => Promise.resolve(undefined),
  showSaveDialog: (..._args: unknown[]) => Promise.resolve(undefined),
  createOutputChannel: (name: string) => createFakeOutputChannel(name),
  state: { focused: true },
  onDidChangeWindowState: windowStateEmitter.event,
  fireWindowStateChange(focused: boolean): void {
    window.state.focused = focused;
    windowStateEmitter.fire({ focused });
  },
  withProgress: async <T>(
    _options: { location: ProgressLocation; title?: string; cancellable?: boolean },
    task: (
      progress: Progress<{ message?: string; increment?: number }>,
      token: CancellationToken,
    ) => Promise<T>,
  ): Promise<T> => {
    const source = new CancellationTokenSource();
    const progress: Progress<{ message?: string; increment?: number }> = { report: () => {} };
    return task(progress, source.token);
  },
};

export const workspace = {
  isTrusted: true,
} as WorkspaceMock;

export interface FakeOutputChannel {
  name: string;
  lines: string[];
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(): void;
  hide(): void;
  replace(value: string): void;
  dispose(): void;
}

export function createFakeOutputChannel(name: string): FakeOutputChannel {
  const lines: string[] = [];
  return {
    name,
    lines,
    append: (value: string) => {
      lines.push(value);
    },
    appendLine: (value: string) => {
      lines.push(value);
    },
    clear: () => {
      lines.length = 0;
    },
    show: () => {},
    hide: () => {},
    replace: (value: string) => {
      lines.length = 0;
      lines.push(value);
    },
    dispose: () => {},
  };
}


/** Every `executeCommand` call, in order — lets a test assert on `vscode.diff` and friends. */
export const executedCommands: Array<{ command: string; args: unknown[] }> = [];

export const commands = {
  registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
    registeredCommands.set(command, callback);
    return { dispose: () => registeredCommands.delete(command) };
  },
  executeCommand: async (command: string, ...args: unknown[]) => {
    executedCommands.push({ command, args });
    const callback = registeredCommands.get(command);
    return callback ? callback(...args) : undefined;
  },
};

export function createFakeExtensionContext(): {
  subscriptions: Array<{ dispose: () => void }>;
  secrets: FakeSecretStorage;
  globalState: FakeMemento;
  workspaceState: FakeMemento;
  extension: { packageJSON: { version: string } };
} {
  return {
    subscriptions: [],
    secrets: new FakeSecretStorage(),
    globalState: new FakeMemento(),
    workspaceState: new FakeMemento(),
    extension: { packageJSON: { version: "0.0.0-test" } },
  };
}

export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose: () => void };
}

export class CancellationTokenSource {
  private listeners: Array<() => void> = [];
  token: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    },
  };
  cancel(): void {
    this.token.isCancellationRequested = true;
    for (const listener of this.listeners) {listener();}
  }
  dispose(): void {
    this.listeners = [];
  }
}

/** Every `env.openExternal` target, in order. */
export const openedExternalUrls: string[] = [];

export const env = {
  openExternal: async (uri: Uri): Promise<boolean> => {
    openedExternalUrls.push(uri.toString());
    return true;
  },
  language: "en",
  clipboard: {
    text: "",
    async writeText(value: string): Promise<void> {
      env.clipboard.text = value;
    },
  },
};

export const l10n = {
  t: (message: string, ...args: unknown[]): string =>
    message.replace(/\{(\d+)\}/g, (match, index: string) => {
      const value = args[Number(index)];
      return value === undefined ? match : String(value);
    }),
};

// --- fs/workspace/language plumbing (project/* tests) -----------------------------------------

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class FileSystemError extends Error {
  constructor(message?: string, public code = "Unknown") {
    super(typeof message === "string" ? message : String(message ?? ""));
    this.name = "FileSystemError";
  }
  static FileNotFound = (arg?: unknown) => new FileSystemError(String(arg ?? ""), "FileNotFound");
  static FileExists = (arg?: unknown) => new FileSystemError(String(arg ?? ""), "FileExists");
  static FileIsADirectory = (arg?: unknown) => new FileSystemError(String(arg ?? ""), "FileIsADirectory");
  static NoPermissions = (arg?: unknown) => new FileSystemError(String(arg ?? ""), "NoPermissions");
  static Unavailable = (arg?: unknown) => new FileSystemError(String(arg ?? ""), "Unavailable");
}

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3,
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}

export const registeredFileSystemProviders = new Map<string, unknown>();
export const addedWorkspaceFolders: Array<{ uri: Uri; name?: string }> = [];

export interface WorkspaceMock {
  isTrusted: boolean;
  workspaceFolders?: WorkspaceFolder[];
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
  fs: {
    readFile(uri: Uri): Promise<Uint8Array>;
    writeFile(uri: Uri, content: Uint8Array): Promise<void>;
    stat(uri: Uri): Promise<{ type: FileType; size: number }>;
    readDirectory(uri: Uri): Promise<Array<[string, FileType]>>;
    createDirectory(uri: Uri): Promise<void>;
  };
  createFileSystemWatcher(pattern: string): FakeFileSystemWatcher;
  registerFileSystemProvider(scheme: string, provider: unknown, options?: unknown): { dispose(): void };
  updateWorkspaceFolders(start: number, deleteCount: number, ...added: Array<{ uri: Uri; name?: string }>): boolean;
  onDidChangeWorkspaceFolders: EventEmitter<void>["event"];
  onDidOpenTextDocument: EventEmitter<FakeTextDocument>["event"];
  onDidChangeTextDocument: EventEmitter<{ document: FakeTextDocument }>["event"];
  onDidSaveTextDocument: EventEmitter<FakeTextDocument>["event"];
  onDidCloseTextDocument: EventEmitter<FakeTextDocument>["event"];
  textDocuments: FakeTextDocument[];
}

Object.assign(workspace, {
  workspaceFolders: undefined as WorkspaceFolder[] | undefined,

  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    return (workspace.workspaceFolders ?? []).find((folder) => uri.path.startsWith(folder.uri.path));
  },

  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const buf = await readFile(uri.fsPath);
      return new Uint8Array(buf);
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      await writeFile(uri.fsPath, Buffer.from(content));
    },
    async stat(uri: Uri): Promise<{ type: FileType; size: number }> {
      const s = await stat(uri.fsPath);
      return {
        type: s.isDirectory() ? FileType.Directory : s.isFile() ? FileType.File : FileType.Unknown,
        size: s.size,
      };
    },
    async readDirectory(uri: Uri): Promise<Array<[string, FileType]>> {
      const entries = await readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [
        entry.name,
        entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown,
      ]);
    },
    async createDirectory(uri: Uri): Promise<void> {
      await mkdir(uri.fsPath, { recursive: true });
    },
  },

  createFileSystemWatcher(_pattern: string): FakeFileSystemWatcher {
    return createFakeFileSystemWatcher();
  },

  registerFileSystemProvider(scheme: string, provider: unknown, _options?: unknown) {
    registeredFileSystemProviders.set(scheme, provider);
    return { dispose: () => registeredFileSystemProviders.delete(scheme) };
  },

  updateWorkspaceFolders(start: number, deleteCount: number, ...added: Array<{ uri: Uri; name?: string }>): boolean {
    addedWorkspaceFolders.push(...added);
    const folders = workspace.workspaceFolders ?? [];
    folders.splice(
      start,
      deleteCount,
      ...added.map((entry, index) => ({ uri: entry.uri, name: entry.name ?? "", index: start + index })),
    );
    workspace.workspaceFolders = folders;
    return true;
  },

  onDidChangeWorkspaceFolders: workspaceFoldersEmitter().event,
  onDidOpenTextDocument: openDocEmitter().event,
  onDidChangeTextDocument: changeDocEmitter().event,
  onDidSaveTextDocument: saveDocEmitter().event,
  onDidCloseTextDocument: closeDocEmitter().event,
  textDocuments: [] as FakeTextDocument[],
} satisfies Partial<WorkspaceMock>);

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

export interface FakeFileSystemWatcher {
  onDidChange: EventEmitter<Uri>["event"];
  onDidCreate: EventEmitter<Uri>["event"];
  onDidDelete: EventEmitter<Uri>["event"];
  fireChange(uri: Uri): void;
  fireCreate(uri: Uri): void;
  fireDelete(uri: Uri): void;
  dispose(): void;
}

export function createFakeFileSystemWatcher(): FakeFileSystemWatcher {
  const change = new EventEmitter<Uri>();
  const create = new EventEmitter<Uri>();
  const del = new EventEmitter<Uri>();
  return {
    onDidChange: change.event,
    onDidCreate: create.event,
    onDidDelete: del.event,
    fireChange: (uri) => change.fire(uri),
    fireCreate: (uri) => create.fire(uri),
    fireDelete: (uri) => del.fire(uri),
    dispose: () => {
      change.dispose();
      create.dispose();
      del.dispose();
    },
  };
}

function workspaceFoldersEmitter(): EventEmitter<void> {
  return new EventEmitter<void>();
}
function openDocEmitter(): EventEmitter<FakeTextDocument> {
  return new EventEmitter<FakeTextDocument>();
}
function changeDocEmitter(): EventEmitter<{ document: FakeTextDocument }> {
  return new EventEmitter<{ document: FakeTextDocument }>();
}
function saveDocEmitter(): EventEmitter<FakeTextDocument> {
  return new EventEmitter<FakeTextDocument>();
}
function closeDocEmitter(): EventEmitter<FakeTextDocument> {
  return new EventEmitter<FakeTextDocument>();
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(public start: Position, public end: Position) {}
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  constructor(public range: Range, public message: string, public severity: DiagnosticSeverity) {}
}

export enum CompletionItemKind {
  Property = 9,
  File = 16,
  EnumMember = 19,
  Value = 11,
}

export class CompletionItem {
  detail?: string;
  insertText?: string;
  constructor(public label: string, public kind?: CompletionItemKind) {}
}

export class MarkdownString {
  constructor(public value: string = "") {}
  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
}

export class Hover {
  constructor(public contents: MarkdownString) {}
}

export interface FakeTextDocument {
  uri: Uri;
  languageId: string;
  getText(): string;
  lineAt(line: number): { text: string };
}

export function createFakeTextDocument(uri: Uri, text: string, languageId = "vertracloud-config"): FakeTextDocument {
  const lines = text.split(/\r?\n/);
  return {
    uri,
    languageId,
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  };
}

interface FakeDiagnosticCollection {
  set(uri: Uri, diagnostics: Diagnostic[]): void;
  delete(uri: Uri): void;
  get(uri: Uri): Diagnostic[] | undefined;
  dispose(): void;
}

export const languages = {
  createDiagnosticCollection(_name?: string): FakeDiagnosticCollection {
    const store = new Map<string, Diagnostic[]>();
    return {
      set: (uri, diagnostics) => store.set(uri.toString(), diagnostics),
      delete: (uri) => store.delete(uri.toString()),
      get: (uri) => store.get(uri.toString()),
      dispose: () => store.clear(),
    };
  },
  registerCompletionItemProvider: (
    _selector: unknown,
    provider: { provideCompletionItems(document: FakeTextDocument, position: Position): unknown },
    ..._triggers: string[]
  ) => {
    registeredCompletionProviders.push(provider);
    return { dispose: () => {} };
  },
  registerHoverProvider: (
    _selector: unknown,
    provider: { provideHover(document: FakeTextDocument, position: Position): unknown },
  ) => {
    registeredHoverProviders.push(provider);
    return { dispose: () => {} };
  },
};

export const registeredCompletionProviders: Array<{
  provideCompletionItems(document: FakeTextDocument, position: Position): unknown;
}> = [];
export const registeredHoverProviders: Array<{
  provideHover(document: FakeTextDocument, position: Position): unknown;
}> = [];

export class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {this.data.delete(key);}
    else {this.data.set(key, value);}
  }
  keys(): readonly string[] {
    return [...this.data.keys()];
  }
}


// --- virtual documents (resolve/* tests) -------------------------------------------------------

Object.assign(workspace, {
  registerTextDocumentContentProvider(
    _scheme: string,
    _provider: { provideTextDocumentContent(uri: Uri): string },
  ): { dispose: () => void } {
    return { dispose: () => {} };
  },

  async openTextDocument(
    arg: Uri | { language?: string; content?: string },
  ): Promise<{ uri?: Uri; content?: string; languageId?: string }> {
    const doc =
      arg instanceof Uri
        ? { uri: arg, content: undefined, languageId: undefined }
        : { uri: undefined, content: arg.content, languageId: arg.language };
    openedTextDocuments.push(doc);
    return doc;
  },
});
