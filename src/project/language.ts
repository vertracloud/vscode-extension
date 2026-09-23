import * as vscode from "vscode";
import { KEY_DOCS, KNOWN_KEYS, KnownKey, parseConfig, validateConfig } from "./config";

export const LANGUAGE_ID = "vertracloud-config";

const IGNORED_DIRS = new Set(["node_modules", ".git", "venv", ".venv", "__pycache__", "dist", ".next"]);
const VERSION_SUGGESTIONS = ["recommended", "latest", "auto"];
const MEMORY_SUGGESTIONS = ["100", "256", "512", "1024", "2048"];
const DEBOUNCE_MS = 300;

async function listFiles(dirUri: vscode.Uri, depth = 0, prefix = ""): Promise<string[]> {
  if (depth > 2) {return [];}
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const [name, type] of entries) {
    if (IGNORED_DIRS.has(name)) {continue;}
    if (type === vscode.FileType.Directory) {
      results.push(...(await listFiles(vscode.Uri.joinPath(dirUri, name), depth + 1, `${prefix}${name}/`)));
    } else if (type === vscode.FileType.File) {
      results.push(`${prefix}${name}`);
    }
  }
  return results;
}

function lineKey(lineText: string): { key: string; afterEquals: boolean } | undefined {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lineText);
  if (!match) {return undefined;}
  return { key: match[1].toUpperCase(), afterEquals: true };
}

async function fileExists(folderUri: vscode.Uri, relativePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(folderUri, relativePath));
    return true;
  } catch {
    return false;
  }
}

function folderUriFor(document: vscode.TextDocument): vscode.Uri {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  return folder ? folder.uri : vscode.Uri.joinPath(document.uri, "..");
}

class ConfigCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly deps: { getRuntimes?: () => Promise<string[]> }) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const lineText = document.lineAt(position.line).text.slice(0, position.character);
    const parsed = lineKey(lineText);

    if (!parsed) {
      return KNOWN_KEYS.map((key) => {
        const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
        item.detail = KEY_DOCS[key as KnownKey];
        item.insertText = `${key}=`;
        return item;
      });
    }

    if (parsed.key === "MAIN") {
      const files = await listFiles(folderUriFor(document));
      return files.map((file) => new vscode.CompletionItem(file, vscode.CompletionItemKind.File));
    }

    if (parsed.key === "VERSION") {
      const runtimes = (await this.deps.getRuntimes?.()) ?? [];
      return [...VERSION_SUGGESTIONS, ...runtimes].map(
        (value) => new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember),
      );
    }

    if (parsed.key === "MEMORY") {
      return MEMORY_SUGGESTIONS.map((value) => new vscode.CompletionItem(value, vscode.CompletionItemKind.Value));
    }

    return [];
  }
}

class ConfigHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const lineText = document.lineAt(position.line).text;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lineText);
    if (!match) {return undefined;}
    const key = match[1].toUpperCase();
    const doc = KEY_DOCS[key as KnownKey];
    if (!doc) {return undefined;}
    return new vscode.Hover(new vscode.MarkdownString(doc));
  }
}

export interface LanguageDeps {
  getRuntimes?: () => Promise<string[]>;
}

/** Registers completion, hover and diagnostics for the `vertracloud-config` language. */
export function registerConfigLanguage(context: { subscriptions: vscode.Disposable[] }, deps: LanguageDeps): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  context.subscriptions.push(diagnostics);

  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const validate = async (document: vscode.TextDocument): Promise<void> => {
    if (document.languageId !== LANGUAGE_ID) {return;}
    const { values, lines } = parseConfig(document.getText());
    const folderUri = folderUriFor(document);
    const issues = await validateConfig(values, {
      fileExists: (relativePath) => fileExists(folderUri, relativePath),
      runtimes: await deps.getRuntimes?.(),
    });

    const diags: vscode.Diagnostic[] = [];
    for (const issue of issues) {
      const target = lines.find((l) => l.key === issue.key);
      const line = target?.line ?? 0;
      const startCol = target?.valueColumn ?? target?.keyColumn ?? 0;
      const endCol = target ? target.raw.length : 0;
      const range = new vscode.Range(new vscode.Position(line, startCol), new vscode.Position(line, endCol));
      diags.push(
        new vscode.Diagnostic(
          range,
          issue.message,
          issue.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        ),
      );
    }
    diagnostics.set(document.uri, diags);
  };

  const scheduleValidate = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    const existing = timers.get(key);
    if (existing) {clearTimeout(existing);}
    timers.set(
      key,
      setTimeout(() => void validate(document), DEBOUNCE_MS),
    );
  };

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(LANGUAGE_ID, new ConfigCompletionProvider(deps), "="),
    vscode.languages.registerHoverProvider(LANGUAGE_ID, new ConfigHoverProvider()),
    vscode.workspace.onDidOpenTextDocument((document) => void validate(document)),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleValidate(event.document)),
    vscode.workspace.onDidSaveTextDocument((document) => void validate(document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      const existing = timers.get(key);
      if (existing) {clearTimeout(existing);}
      timers.delete(key);
      diagnostics.delete(document.uri);
    }),
  );

  for (const document of vscode.workspace.textDocuments) {void validate(document);}
}
