import * as vscode from "vscode";

export const CONFIG_FILE_NAME = "vertracloud.config";

export interface ParsedLine {
  line: number;
  raw: string;
  key?: string;
  keyColumn?: number;
  value?: string;
  valueColumn?: number;
}

export interface ParsedConfig {
  values: Record<string, string>;
  lines: ParsedLine[];
}

export const KNOWN_KEYS = ["ID", "NAME", "MEMORY", "MAIN", "VERSION", "SUBDOMAIN", "START", "BUILD", "DESCRIPTION"] as const;
export type KnownKey = (typeof KNOWN_KEYS)[number];

export const KEY_DOCS: Record<KnownKey, string> = {
  ID: "Application id. Set automatically when the folder is linked.",
  NAME: "Application name shown in the dashboard.",
  MEMORY: "Memory in MB, integer, minimum 100.",
  MAIN: "Entry point file, relative to the project root.",
  VERSION: "Runtime version: recommended, latest, auto, or a specific version.",
  SUBDOMAIN: "Desired subdomain: lowercase letters, digits and hyphens.",
  START: "Custom start command, overrides package.json.",
  BUILD: "Custom build command, run before start.",
  DESCRIPTION: "Short description shown in the dashboard.",
};

/** Parses `vertracloud.config` (simple INI, `KEY=VALUE` per line), keeping position for diagnostics. */
export function parseConfig(text: string): ParsedConfig {
  const values: Record<string, string> = {};
  const lines: ParsedLine[] = [];
  const rawLines = text.split(/\r?\n/);

  rawLines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      lines.push({ line: index, raw });
      return;
    }
    const eq = raw.indexOf("=");
    if (eq === -1) {
      lines.push({ line: index, raw });
      return;
    }
    const keyRaw = raw.slice(0, eq);
    const keyColumn = keyRaw.length - keyRaw.trimStart().length;
    const key = keyRaw.trim().toUpperCase();
    if (!key) {
      lines.push({ line: index, raw });
      return;
    }
    const valueRaw = raw.slice(eq + 1);
    const valueColumn = eq + 1 + (valueRaw.length - valueRaw.trimStart().length);
    const value = valueRaw.trim();
    values[key] = value;
    lines.push({ line: index, raw, key, keyColumn, value, valueColumn });
  });

  return { values, lines };
}

/** Updates the `KEY=` line in `text`, appending it if absent; preserves the rest and trailing `\n`. */
export function serializeSet(text: string, key: string, value: string): string {
  const upperKey = key.toUpperCase();
  const rawLines = text.length > 0 ? text.split(/\r?\n/) : [];
  // drop a single trailing empty line so we don't accumulate blank lines on repeated writes
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {rawLines.pop();}

  const re = new RegExp(`^\\s*${upperKey}\\s*=`, "i");
  let found = false;
  const next = rawLines.map((line) => {
    if (re.test(line)) {
      found = true;
      return `${upperKey}=${value}`;
    }
    return line;
  });
  if (!found) {next.push(`${upperKey}=${value}`);}
  return `${next.join("\n")}\n`;
}

function configUri(folderUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(folderUri, CONFIG_FILE_NAME);
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Reads and parses `vertracloud.config` from a workspace folder, if it exists. */
export async function readConfig(folderUri: vscode.Uri): Promise<ParsedConfig | undefined> {
  const text = await readText(configUri(folderUri));
  if (text === undefined) {return undefined;}
  return parseConfig(text);
}

export interface ConfigSource {
  id: string;
  name: string;
  ram: number;
  main_file: string;
  version: string;
  start_command: string | null;
  build_command: string | null;
  subdomain: string | null;
  description?: string;
}

/** Full `vertracloud.config` for an application, in the key order the CLI documents. */
export function buildConfigFromApp(app: ConfigSource): string {
  const subdomain = app.subdomain ? app.subdomain.split(".")[0] : "";
  const lines: Array<[KnownKey, string]> = [
    ["ID", app.id],
    ["NAME", app.name],
    ["MEMORY", String(app.ram)],
    ["MAIN", app.main_file],
    ["VERSION", app.version || "recommended"],
    ["SUBDOMAIN", subdomain],
    ["START", app.start_command ?? ""],
    ["BUILD", app.build_command ?? ""],
    ["DESCRIPTION", app.description ?? ""],
  ];
  return lines
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";
}

/** Sets a single key in `vertracloud.config`, creating the file if it doesn't exist yet. */
export async function writeConfigKey(folderUri: vscode.Uri, key: string, value: string): Promise<void> {
  const uri = configUri(folderUri);
  const current = (await readText(uri)) ?? "";
  const next = serializeSet(current, key, value);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(next, "utf8"));
}

export interface ValidateContext {
  fileExists(relativePath: string): Promise<boolean>;
  runtimes?: string[];
}

export interface ValidationIssue {
  key: string;
  severity: "error" | "warning";
  message: string;
}

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const KNOWN_VERSIONS = ["recommended", "latest", "auto"];

/** Mirrors the CLI `doctor` rules for `vertracloud.config` values. */
export async function validateConfig(
  values: Record<string, string>,
  ctx: ValidateContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  for (const key of Object.keys(values)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      issues.push({ key, severity: "warning", message: `Unknown key: ${key}` });
    }
  }

  if (values.MEMORY !== undefined) {
    const memory = Number.parseInt(values.MEMORY, 10);
    if (!Number.isInteger(memory) || String(memory) !== values.MEMORY.trim() || memory < 100) {
      issues.push({ key: "MEMORY", severity: "error", message: "MEMORY must be an integer of at least 100." });
    }
  }

  if (values.MAIN !== undefined) {
    const exists = await ctx.fileExists(values.MAIN);
    if (!exists) {
      issues.push({ key: "MAIN", severity: "error", message: `File not found: ${values.MAIN}` });
    }
  }

  if (values.SUBDOMAIN !== undefined && !SUBDOMAIN_RE.test(values.SUBDOMAIN)) {
    issues.push({
      key: "SUBDOMAIN",
      severity: "error",
      message: "SUBDOMAIN must use only lowercase letters, digits and hyphens.",
    });
  }

  if (values.VERSION !== undefined) {
    const known = ctx.runtimes ?? [];
    if (!KNOWN_VERSIONS.includes(values.VERSION) && !known.includes(values.VERSION)) {
      issues.push({
        key: "VERSION",
        severity: "warning",
        message: `Unknown runtime version: ${values.VERSION}`,
      });
    }
  }

  if (values.NAME !== undefined && values.NAME.length > 50) {
    issues.push({ key: "NAME", severity: "error", message: "NAME must be 50 characters or fewer." });
  }
  if (values.START !== undefined && values.START.length > 512) {
    issues.push({ key: "START", severity: "error", message: "START must be 512 characters or fewer." });
  }
  if (values.BUILD !== undefined && values.BUILD.length > 512) {
    issues.push({ key: "BUILD", severity: "error", message: "BUILD must be 512 characters or fewer." });
  }

  return issues;
}
