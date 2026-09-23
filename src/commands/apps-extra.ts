import * as vscode from "vscode";
import type { APIApplicationDeployment } from "@vertracloud/api-types/v1";
import { downloadApp, saveBufferInteractive } from "../api/snapshots";
import { getAppDeploys, getDeployWebhook } from "../api/deploys";
import type { ApiClient } from "../api/client";
import type { CommandDeps } from "./deps";

/** Só os campos que `app.editConfig` edita (subconjunto de `UpdateAppConfigBodySchema`, api/src/@types/app.ts). */
type ConfigPatch =
  | { field: "name"; value: string }
  | { field: "description"; value: string | null }
  | { field: "main_file"; value: string }
  | { field: "version"; value: string }
  | { field: "start_command"; value: string | null }
  | { field: "build_command"; value: string | null }
  | { field: "ram"; value: number };

function updateAppConfig(client: ApiClient, appId: string, patch: ConfigPatch): Promise<string> {
  return client.request<string>(`/v1/apps/${appId}/config`, {
    method: "PATCH",
    body: { [patch.field]: patch.value },
  });
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(vscode.env.language, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

function deployItem(deploy: APIApplicationDeployment): vscode.QuickPickItem {
  const commit = deploy.commit_id ? deploy.commit_id.slice(0, 7) : undefined;
  return {
    label: `$(git-commit) ${formatDate(deploy.created_at)}`,
    description: [deploy.branch, commit].filter(Boolean).join(" · "),
    detail: [deploy.message, deploy.pusher ? vscode.l10n.t("by {0}", deploy.pusher) : undefined]
      .filter(Boolean)
      .join(" — ") || undefined,
  };
}

async function showDeploys(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}
  const appId = entry.app.id;

  let deploys: APIApplicationDeployment[];
  try {
    deploys = await getAppDeploys(deps.client, appId);
  } catch (err) {
    deps.showError(err);
    return;
  }

  let repoOwner = entry.app.github?.repo_owner;
  let repoName = entry.app.github?.repo_name;
  if (!repoOwner || !repoName) {
    try {
      const webhook = await getDeployWebhook(deps.client, appId);
      repoOwner = repoOwner ?? webhook.repoOwner;
      repoName = repoName ?? webhook.repoName;
    } catch {
      // 404/403: sem repositório vinculado ou sem acesso — segue sem o item de repositório.
    }
  }

  const items: (vscode.QuickPickItem & { url?: string; action?: "download" })[] = [];
  if (repoOwner && repoName) {
    items.push({
      label: `$(github) ${vscode.l10n.t("Repository: {0}", `${repoOwner}/${repoName}`)}`,
      url: `https://github.com/${repoOwner}/${repoName}`,
    });
  }
  items.push({
    label: `$(cloud-download) ${vscode.l10n.t("Download source")}`,
    action: "download",
  });

  if (deploys.length > 0) {
    items.push({ label: vscode.l10n.t("Deploys"), kind: vscode.QuickPickItemKind.Separator });
    items.push(...deploys.map(deployItem));
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Deploys — {0}", entry.app.name),
  });
  if (!picked) {return;}

  if (picked.url) {
    await vscode.env.openExternal(vscode.Uri.parse(picked.url));
    return;
  }
  if (picked.action === "download") {
    let buffer: ArrayBuffer;
    try {
      buffer = await downloadApp(deps.client, appId);
    } catch (err) {
      deps.showError(err);
      return;
    }
    await saveBufferInteractive(buffer, `${entry.app.name}.zip`);
  }
}

interface FieldSpec {
  field: ConfigPatch["field"];
  label: string;
  nullable: boolean;
  maxLength?: number;
  isRam?: boolean;
  current(app: { name: string; description?: string; main_file: string; version: string; start_command: string | null; build_command: string | null; ram: number }): string;
}

const FIELDS: FieldSpec[] = [
  { field: "name", label: vscode.l10n.t("Name"), nullable: false, maxLength: 50, current: (a) => a.name },
  { field: "description", label: vscode.l10n.t("Description"), nullable: true, maxLength: 128, current: (a) => a.description ?? "" },
  { field: "main_file", label: vscode.l10n.t("Main file"), nullable: false, current: (a) => a.main_file },
  { field: "version", label: vscode.l10n.t("Version"), nullable: false, current: (a) => a.version },
  { field: "start_command", label: vscode.l10n.t("Start command"), nullable: true, maxLength: 512, current: (a) => a.start_command ?? "" },
  { field: "build_command", label: vscode.l10n.t("Build command"), nullable: true, maxLength: 512, current: (a) => a.build_command ?? "" },
  { field: "ram", label: vscode.l10n.t("RAM (MB)"), nullable: false, isRam: true, current: (a) => String(a.ram) },
];

function validateField(spec: FieldSpec, raw: string): string | undefined {
  if (spec.isRam) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 100) {
      return vscode.l10n.t("RAM must be a whole number of at least 100 MB.");
    }
    return undefined;
  }
  if (raw.length === 0 && !spec.nullable) {
    return vscode.l10n.t("This field can't be empty.");
  }
  if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
    return vscode.l10n.t("Must be at most {0} characters.", spec.maxLength);
  }
  return undefined;
}

async function editConfig(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}
  const app = entry.app;

  const picked = await vscode.window.showQuickPick(
    FIELDS.map((spec) => ({ label: spec.label, detail: spec.current(app), spec })),
    { title: vscode.l10n.t("Edit configuration — {0}", app.name) },
  );
  if (!picked) {return;}
  const spec = picked.spec;

  const raw = await vscode.window.showInputBox({
    title: spec.label,
    value: spec.current(app),
    validateInput: (value) => validateField(spec, value),
  });
  if (raw === undefined) {return;}

  if (spec.field === "build_command") {
    const proceed = vscode.l10n.t("Continue");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Changing the build command counts toward your hourly deploy limit."),
      { modal: true },
      proceed,
    );
    if (choice !== proceed) {return;}
  }

  const patch: ConfigPatch = spec.isRam
    ? { field: "ram", value: Number(raw) }
    : spec.nullable
      ? { field: spec.field as "description" | "start_command" | "build_command", value: raw.length === 0 ? null : raw }
      : { field: spec.field as "name" | "main_file" | "version", value: raw };

  try {
    await updateAppConfig(deps.client, app.id, patch);
  } catch (err) {
    deps.showError(err);
    return;
  }
  await deps.refresh();
}

export function registerAppsExtraCommands(deps: CommandDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.app.showDeploys", (arg: unknown) => showDeploys(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.app.editConfig", (arg: unknown) => editConfig(deps, arg)),
  );
}
