import * as vscode from "vscode";
import type { APIDatabase, APIDatabaseMetrics, DatabaseType } from "@vertracloud/api-types/v1";
import {
  createDatabase,
  deleteDatabase,
  downloadDatabaseCertificate,
  getDatabaseMetrics,
  resetDatabasePassword,
  startDatabase,
  stopDatabase,
  updateDatabase,
} from "../api/databases";
import { saveBufferInteractive } from "../api/snapshots";
import type { CommandDeps } from "./deps";
import { workspaceIdOf } from "./index";

interface EngineInfo {
  type: DatabaseType;
  label: string;
  minRam: number;
  defaultUser: string;
}

/**
 * Mínimos e usuário padrão por engine, conforme a KB e a criação no control plane.
 * `DatabaseType` é `1|2|3|4` (api-types); os literais aqui seguem essa mesma numeração.
 */
const ENGINES: EngineInfo[] = [
  { type: 1, label: "PostgreSQL", minRam: 1024, defaultUser: "postgres" },
  { type: 2, label: "MongoDB", minRam: 1024, defaultUser: "default" },
  { type: 3, label: "Redis", minRam: 512, defaultUser: vscode.l10n.t("none") },
  { type: 4, label: "MySQL", minRam: 1024, defaultUser: "root" },
];

function engineOf(type: DatabaseType): EngineInfo {
  return ENGINES.find((e) => e.type === type) ?? ENGINES[0];
}

async function pickEngine(): Promise<EngineInfo | undefined> {
  const picked = await vscode.window.showQuickPick(
    ENGINES.map((engine) => ({ label: engine.label, engine })),
    { placeHolder: vscode.l10n.t("Choose the database engine") },
  );
  return picked?.engine;
}

async function inputRam(minRam: number): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("RAM in MB"),
    value: String(minRam),
    validateInput: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < minRam) {
        return vscode.l10n.t("Enter an integer of at least {0} MB.", minRam);
      }
      return undefined;
    },
  });
  return value === undefined ? undefined : Number(value);
}

async function createDb(deps: CommandDeps): Promise<void> {
  const engine = await pickEngine();
  if (!engine) {return;}

  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Database name"),
    validateInput: (v) => {
      if (v.length < 1 || v.length > 50) {return vscode.l10n.t("The name must be between 1 and 50 characters.");}
      return undefined;
    },
  });
  if (name === undefined) {return;}

  const ram = await inputRam(engine.minRam);
  if (ram === undefined) {return;}

  const description = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Description (optional)"),
  });

  try {
    await createDatabase(deps.client, {
      name,
      ram,
      type: engine.type,
      description: description || undefined,
    });
    await deps.refresh();
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Database created. The password is shown only once — use \"Reset password\" to get one.",
      ),
    );
  } catch (err) {
    deps.showError(err);
  }
}

async function operate(
  deps: CommandDeps,
  arg: unknown,
  action: (id: string) => Promise<unknown>,
): Promise<void> {
  const entry = await deps.resolveDatabase(arg);
  if (!entry) {return;}
  try {
    await action(entry.db.id);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

function peak(values: number[]): number {
  return values.reduce((max, v) => (v > max ? v : max), 0);
}

async function showMetrics(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveDatabase(arg);
  if (!entry) {return;}

  let metrics: APIDatabaseMetrics[];
  try {
    metrics = await getDatabaseMetrics(deps.client, entry.db.id, "30m");
  } catch (err) {
    deps.showError(err);
    return;
  }

  if (metrics.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("No metrics available yet."));
    return;
  }

  const last = metrics[metrics.length - 1];
  const peakCpu = peak(metrics.map((m) => m.cpu));
  const peakRam = peak(metrics.map((m) => m.ram));

  await vscode.window.showQuickPick(
    [
      { label: vscode.l10n.t("Last: CPU {0}% · RAM {1}%", last.cpu, last.ram) },
      { label: vscode.l10n.t("Peak: CPU {0}% · RAM {1}%", peakCpu, peakRam) },
    ],
    { placeHolder: entry.db.name },
  );
}

async function downloadCertificate(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveDatabase(arg);
  if (!entry) {return;}
  try {
    const buffer = await downloadDatabaseCertificate(deps.client, entry.db.id);
    await saveBufferInteractive(buffer, `${entry.db.name}-ca.pem`);
  } catch (err) {
    deps.showError(err);
  }
}

async function resetPassword(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveDatabase(arg);
  if (!entry) {return;}

  const confirmed = await deps.confirmDanger(entry.db.name, vscode.l10n.t("reset the password"));
  if (!confirmed) {return;}

  let password: string;
  try {
    const result = await resetDatabasePassword(deps.client, entry.db.id);
    password = result.password;
  } catch (err) {
    deps.showError(err);
    return;
  }

  const engine = engineOf(entry.db.type);
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "New password for {0} ({1}, user \"{2}\", {3}:{4}): {5}\nThis password won't be shown again.",
      entry.db.name,
      engine.label,
      engine.defaultUser,
      entry.db.host,
      entry.db.port,
      password,
    ),
    { modal: true },
    vscode.l10n.t("Copy"),
  );
  if (choice === vscode.l10n.t("Copy")) {
    await vscode.env.clipboard.writeText(password);
  }
}

type EditField = "name" | "description" | "ram";

async function editDb(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveDatabase(arg);
  if (!entry) {return;}

  const fields: Array<{ label: string; field: EditField }> = [
    { label: vscode.l10n.t("Name"), field: "name" },
    { label: vscode.l10n.t("Description"), field: "description" },
    { label: vscode.l10n.t("RAM"), field: "ram" },
  ];
  const picked = await vscode.window.showQuickPick(fields, { placeHolder: entry.db.name });
  if (!picked) {return;}

  if (picked.field === "ram") {
    const engine = engineOf(entry.db.type);
    const ram = await inputRam(engine.minRam);
    if (ram === undefined) {return;}
    try {
      await updateDatabase(deps.client, entry.db.id, { ram });
      await deps.refresh();
    } catch (err) {
      deps.showError(err);
    }
    return;
  }

  const current = picked.field === "name" ? entry.db.name : entry.db.description;
  const value = await vscode.window.showInputBox({
    prompt: picked.label,
    value: current ?? "",
    validateInput: (v) => {
      if (picked.field === "name" && (v.length < 1 || v.length > 50)) {
        return vscode.l10n.t("The name must be between 1 and 50 characters.");
      }
      if (picked.field === "description" && v.length > 128) {
        return vscode.l10n.t("The description must be at most 128 characters.");
      }
      return undefined;
    },
  });
  if (value === undefined) {return;}

  try {
    await updateDatabase(deps.client, entry.db.id, { [picked.field]: value } as Partial<
      Pick<APIDatabase, "name" | "description">
    >);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

async function deleteDb(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveDatabase(arg);
  if (!entry) {return;}
  const confirmed = await deps.confirmDanger(entry.db.name, vscode.l10n.t("delete this database"));
  if (!confirmed) {return;}
  try {
    await deleteDatabase(deps.client, entry.db.id);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

function databaseIdOf(arg: unknown): string | undefined {
  if (!arg || typeof arg !== "object") {return typeof arg === "string" ? arg : undefined;}
  const db = (arg as { db?: { id?: unknown } }).db;
  return typeof db?.id === "string" ? db.id : undefined;
}

async function toggleFavorite(deps: CommandDeps, arg: unknown, favorite: boolean): Promise<void> {
  const workspaceId = workspaceIdOf(arg);
  const id = databaseIdOf(arg);
  if (id) {
    const current = deps.store.isFavorite("database", id, workspaceId);
    if (current !== favorite) {await deps.store.toggleFavorite("database", id, workspaceId);}
    return;
  }
  const entry = await deps.resolveDatabase(arg);
  if (entry && entry.favorite !== favorite) {await deps.store.toggleFavorite("database", entry.db.id, workspaceId);}
}

export function registerDatabasesCommands(deps: CommandDeps): void {
  const register = (id: string, handler: (arg: unknown) => Promise<void>) => {
    deps.context.subscriptions.push(vscode.commands.registerCommand(id, (arg?: unknown) => handler(arg)));
  };

  register("vertraCloud.db.create", () => createDb(deps));
  register("vertraCloud.db.start", (arg) => operate(deps, arg, (id) => startDatabase(deps.client, id)));
  register("vertraCloud.db.stop", (arg) => operate(deps, arg, (id) => stopDatabase(deps.client, id)));
  register("vertraCloud.db.showMetrics", (arg) => showMetrics(deps, arg));
  register("vertraCloud.db.downloadCertificate", (arg) => downloadCertificate(deps, arg));
  register("vertraCloud.db.resetPassword", (arg) => resetPassword(deps, arg));
  register("vertraCloud.db.edit", (arg) => editDb(deps, arg));
  register("vertraCloud.db.delete", (arg) => deleteDb(deps, arg));
  register("vertraCloud.db.favorite", (arg) => toggleFavorite(deps, arg, true));
  register("vertraCloud.db.unfavorite", (arg) => toggleFavorite(deps, arg, false));
}
