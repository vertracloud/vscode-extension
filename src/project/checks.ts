import * as vscode from "vscode";
import { CONFIG_FILE_NAME, readConfig, validateConfig, writeConfigKey } from "./config";

export type CheckSeverity = "info" | "warning" | "error";

export interface CheckResult {
  severity: CheckSeverity;
  message: string;
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "venv", ".venv", "__pycache__", "dist", ".next"]);
const FORBIDDEN_ENV_KEYS = ["PORT", "HOST", "PATH", "HOME", "USER", "SHELL"];

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

interface WalkEntry {
  path: string[];
  type: vscode.FileType;
  bytes: number;
}

async function walk(dirUri: vscode.Uri, depth = 0, path: string[] = []): Promise<WalkEntry[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    return [];
  }
  const results: WalkEntry[] = [];
  for (const [name, type] of entries) {
    if (IGNORED_DIRS.has(name)) {continue;}
    const childPath = [...path, name];
    const childUri = vscode.Uri.joinPath(dirUri, name);
    if (type === vscode.FileType.Directory) {
      results.push({ path: childPath, type, bytes: 0 });
      results.push(...(await walk(childUri, depth + 1, childPath)));
    } else if (type === vscode.FileType.File) {
      let bytes = 0;
      try {
        const stat = await vscode.workspace.fs.stat(childUri);
        bytes = stat.size;
      } catch {
        // ignore unreadable files, they don't count toward size
      }
      results.push({ path: childPath, type, bytes });
    }
  }
  return results;
}

function parseEnvKeys(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")).trim().toUpperCase());
}

async function checkConfig(folder: vscode.WorkspaceFolder): Promise<CheckResult[]> {
  const config = await readConfig(folder.uri);
  if (!config) {
    return [{ severity: "warning", message: vscode.l10n.t("No {0} found in this project.", CONFIG_FILE_NAME) }];
  }
  const issues = await validateConfig(config.values, {
    fileExists: (relativePath) => exists(vscode.Uri.joinPath(folder.uri, relativePath)),
  });
  if (issues.length === 0) {return [{ severity: "info", message: vscode.l10n.t("Configuration is valid.") }];}
  return issues.map((issue) => ({
    severity: issue.severity === "error" ? "error" : "warning",
    message: `${issue.key}: ${issue.message}`,
  }));
}

async function checkNode(folder: vscode.WorkspaceFolder): Promise<CheckResult[]> {
  const pkgUri = vscode.Uri.joinPath(folder.uri, "package.json");
  const pkgText = await readText(pkgUri);
  if (pkgText === undefined) {return [];}

  const results: CheckResult[] = [];
  let pkg: { type?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return [{ severity: "error", message: vscode.l10n.t("package.json is not valid JSON.") }];
  }

  const config = await readConfig(folder.uri);
  const main = config?.values.MAIN;
  if (main && pkg.type === "module" && main.endsWith(".cjs")) {
    results.push({
      severity: "warning",
      message: vscode.l10n.t("package.json has type module but MAIN is a .cjs file."),
    });
  }
  for (const dep of ["tsx", "ts-node", "typescript"]) {
    if (pkg.devDependencies?.[dep] && !pkg.dependencies?.[dep]) {
      results.push({
        severity: "warning",
        message: vscode.l10n.t("{0} is only in devDependencies but may be needed at runtime.", dep),
      });
    }
  }
  if (!(await exists(vscode.Uri.joinPath(folder.uri, "package-lock.json")))) {
    results.push({ severity: "warning", message: vscode.l10n.t("No package-lock.json found.") });
  }
  if (await exists(vscode.Uri.joinPath(folder.uri, "node_modules"))) {
    results.push({ severity: "info", message: vscode.l10n.t("node_modules is present.") });
  }
  return results;
}

async function hasFileWithExt(folder: vscode.WorkspaceFolder, ext: string): Promise<boolean> {
  const entries = await walk(folder.uri);
  return entries.some((entry) => entry.type === vscode.FileType.File && entry.path.at(-1)?.endsWith(ext));
}

async function checkPython(folder: vscode.WorkspaceFolder): Promise<CheckResult[]> {
  if (!(await hasFileWithExt(folder, ".py"))) {return [];}
  const results: CheckResult[] = [];
  if (!(await exists(vscode.Uri.joinPath(folder.uri, "requirements.txt")))) {
    results.push({ severity: "warning", message: vscode.l10n.t("No requirements.txt found.") });
  }
  for (const dir of ["venv", ".venv", "__pycache__"]) {
    if (await exists(vscode.Uri.joinPath(folder.uri, dir))) {
      results.push({ severity: "warning", message: vscode.l10n.t("{0} should not be part of the deploy.", dir) });
    }
  }
  return results;
}

async function checkEnv(folder: vscode.WorkspaceFolder): Promise<CheckResult[]> {
  const envUri = vscode.Uri.joinPath(folder.uri, ".env");
  const text = await readText(envUri);
  if (text === undefined) {return [];}
  const results: CheckResult[] = [{ severity: "warning", message: vscode.l10n.t(".env is present in the project.") }];
  const keys = parseEnvKeys(text);
  const found = [...new Set(keys.filter((key) => FORBIDDEN_ENV_KEYS.includes(key)))];
  if (found.length > 0) {
    results.push({
      severity: "warning",
      message: vscode.l10n.t("Reserved keys in .env: {0}", found.join(", ")),
    });
  }
  return results;
}

async function checkSize(folder: vscode.WorkspaceFolder): Promise<CheckResult[]> {
  const entries = await walk(folder.uri);
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const mb = bytes / (1024 * 1024);
  const size = `${mb.toFixed(1)} MB`;
  if (mb > 100) {return [{ severity: "error", message: vscode.l10n.t("Project is too large to deploy: {0}", size) }];}
  if (mb > 50) {return [{ severity: "warning", message: vscode.l10n.t("Project is large: {0}", size) }];}
  return [{ severity: "info", message: vscode.l10n.t("Project size: {0}", size) }];
}

/** Reproduces the CLI doctor's local checks that don't require a shell. */
export async function runProjectChecks(folder: vscode.WorkspaceFolder): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(...(await checkConfig(folder)));
  results.push(...(await checkNode(folder)));
  results.push(...(await checkPython(folder)));
  results.push(...(await checkEnv(folder)));
  results.push(...(await checkSize(folder)));
  return results;
}

function iconFor(severity: CheckSeverity): string {
  if (severity === "error") {return "$(error)";}
  if (severity === "warning") {return "$(warning)";}
  return "$(check)";
}

/** Shows check results in a QuickPick, or a plain message when there's nothing to report. */
export async function showChecks(results: CheckResult[]): Promise<void> {
  if (results.length === 0) {
    await vscode.window.showInformationMessage(vscode.l10n.t("No problems found."));
    return;
  }
  await vscode.window.showQuickPick(
    results.map((result) => ({ label: `${iconFor(result.severity)} ${result.message}` })),
    { placeHolder: vscode.l10n.t("Project checks") },
  );
}

const RUNTIME_VERSIONS = ["recommended", "latest", "auto"];

/** Interactive creation of `vertracloud.config` via input boxes; never overwrites without confirmation. */
export async function createConfigInteractive(folder: vscode.WorkspaceFolder): Promise<void> {
  const configUri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME);
  if (await exists(configUri)) {
    const overwrite = await vscode.window.showWarningMessage(
      vscode.l10n.t("{0} already exists. Overwrite it?", CONFIG_FILE_NAME),
      { modal: true },
      vscode.l10n.t("Overwrite"),
    );
    if (overwrite !== vscode.l10n.t("Overwrite")) {return;}
  }

  const defaultName = folder.name;
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Application name"),
    value: defaultName,
  });
  if (name === undefined) {return;}

  let mainSuggestion = "index.js";
  const pkgText = await readText(vscode.Uri.joinPath(folder.uri, "package.json"));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { main?: string };
      if (pkg.main) {mainSuggestion = pkg.main;}
    } catch {
      // fall through to defaults below
    }
  } else if (await exists(vscode.Uri.joinPath(folder.uri, "main.py"))) {
    mainSuggestion = "main.py";
  }

  const main = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Main file"),
    value: mainSuggestion,
  });
  if (main === undefined) {return;}

  const memory = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Memory in MB"),
    value: "256",
    validateInput: (value) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== value.trim() || parsed < 100) {
        return vscode.l10n.t("Must be an integer of at least 100.");
      }
      return undefined;
    },
  });
  if (memory === undefined) {return;}

  const version = await vscode.window.showQuickPick(RUNTIME_VERSIONS, {
    placeHolder: vscode.l10n.t("Runtime version"),
  });
  if (version === undefined) {return;}

  await writeConfigKey(folder.uri, "NAME", name);
  await writeConfigKey(folder.uri, "MAIN", main);
  await writeConfigKey(folder.uri, "MEMORY", memory);
  await writeConfigKey(folder.uri, "VERSION", version);
}
