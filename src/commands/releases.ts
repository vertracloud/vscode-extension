import * as vscode from "vscode";
import type { APIApplicationRelease, ApplicationEnvironmentChange, ApplicationReleaseStatus } from "@vertracloud/api-types/v1";
import { getReleaseLog, listReleases, previewRollback, rollbackRelease } from "../api/releases";
import type { CommandDeps } from "./deps";

interface App {
  id: string;
  name: string;
}

type ReleaseItem = vscode.QuickPickItem & { release: APIApplicationRelease };

/** Identificador curto que o painel mostra: SHA no GitHub, começo do id da versão nas demais origens. */
export function releaseRef(release: APIApplicationRelease): string {
  if (release.source === "github" && release.github) {return release.github.commit_id.slice(0, 7);}
  return (release.id.split("-")[0] ?? release.id).slice(0, 8);
}

/** Ativa que ainda não rodou (arquivos enviados sem reiniciar) aguarda reinício: o app ainda roda a anterior. */
export function releaseStatusKey(release: APIApplicationRelease): ApplicationReleaseStatus | "pending_restart" {
  return release.status === "active" && release.first_started_at === null ? "pending_restart" : release.status;
}

function statusLabel(release: APIApplicationRelease): string {
  switch (releaseStatusKey(release)) {
    case "active": return vscode.l10n.t("Active");
    case "pending_restart": return vscode.l10n.t("Awaiting restart");
    case "deploying": return vscode.l10n.t("Deploying");
    case "superseded": return vscode.l10n.t("Replaced");
    case "failed": return vscode.l10n.t("Failed");
    case "rolled_back": return vscode.l10n.t("Rolled back");
    case "expired": return vscode.l10n.t("Expired");
  }
}

function firstLine(text: string | null | undefined): string | null {
  const line = text?.split(/\r?\n/).find((part) => part.trim() !== "");
  return line ? line.trim() : null;
}

/** Título da versão: a mensagem, ou um rótulo pela origem. O rollback cita o destino pelo id que a linha dele mostra. */
function releaseTitle(release: APIApplicationRelease, all: readonly APIApplicationRelease[]): string {
  const text = firstLine(release.message) ?? firstLine(release.github?.message);
  if (text) {return text;}
  switch (release.source) {
    case "github": return vscode.l10n.t("Push to GitHub");
    case "cli": return vscode.l10n.t("Sent from the CLI");
    case "upload": return vscode.l10n.t("Uploaded");
    case "editor": return vscode.l10n.t("{0} files edited", String(release.files_changed));
    case "env_change": return vscode.l10n.t("Environment variables changed");
    case "rollback": {
      const from = release.rollback.from;
      if (!from) {return vscode.l10n.t("Rollback");}
      const target = all.find((r) => r.id === from);
      return vscode.l10n.t("Rollback to {0}", target ? releaseRef(target) : (from.split("-")[0] ?? from).slice(0, 8));
    }
  }
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(vscode.env.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function changeLabel(change: ApplicationEnvironmentChange): string {
  if (change === "added") {return vscode.l10n.t("added");}
  if (change === "removed") {return vscode.l10n.t("removed");}
  return vscode.l10n.t("changed");
}

async function pickRelease(deps: CommandDeps, app: App): Promise<{ release: APIApplicationRelease; all: APIApplicationRelease[] } | undefined> {
  let all: APIApplicationRelease[];
  try {
    all = (await listReleases(deps.client, app.id)).data;
  } catch (err) {
    deps.showError(err);
    return undefined;
  }
  if (all.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("{0} has no versions yet. The history starts with the next deploy.", app.name));
    return undefined;
  }

  const items: ReleaseItem[] = all.map((release) => {
    const until = release.rollback.available && release.rollback.expires_at
      ? ` · ${vscode.l10n.t("available until {0}", formatDate(release.rollback.expires_at))}`
      : "";
    return {
      label: releaseTitle(release, all),
      description: `${statusLabel(release)} · ${releaseRef(release)}`,
      detail: `${release.author} · ${formatDate(release.created_at)}${until}`,
      release,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Rollbacks — {0}", app.name),
    placeHolder: vscode.l10n.t("Select a version"),
    matchOnDescription: true,
  });
  return picked ? { release: picked.release, all } : undefined;
}

async function rollBack(deps: CommandDeps, app: App, release: APIApplicationRelease, all: APIApplicationRelease[]): Promise<void> {
  const ref = releaseRef(release);
  let restoreEnvironment = false;
  try {
    const { environment_changes: changes } = await previewRollback(deps.client, app.id, release.id);
    if (changes.length > 0) {
      const keep = vscode.l10n.t("Keep the current variables");
      const restore = vscode.l10n.t("Restore the variables of this version");
      const names = changes.map((c) => `${c.key} (${changeLabel(c.change)})`).join(", ");
      const choice = await vscode.window.showQuickPick([keep, restore], {
        title: vscode.l10n.t("Environment variables"),
        placeHolder: vscode.l10n.t("Restoring would change: {0}", names),
      });
      if (!choice) {return;}
      restoreEnvironment = choice === restore;
    }
  } catch (err) {
    deps.showError(err);
    return;
  }

  const confirmLabel = vscode.l10n.t("Roll back");
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t("Roll {0} back to {1}?", app.name, releaseTitle(release, all)),
    {
      modal: true,
      detail: vscode.l10n.t("The code returns to this version and the application restarts. Data the application wrote while running stays as it is."),
    },
    confirmLabel,
  );
  if (confirmed !== confirmLabel) {return;}

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Rolling {0} back to {1}...", app.name, ref) },
      () => rollbackRelease(deps.client, app.id, release.id, { restore_environment: restoreEnvironment }),
    );
  } catch (err) {
    deps.showError(err);
    return;
  }
  void vscode.window.showInformationMessage(vscode.l10n.t("{0} is back on version {1}.", app.name, ref));
  deps.remoteFiles?.invalidateApp(app.id);
  await deps.store.pollAfterMutation(app.id, "up");
}

async function viewLog(deps: CommandDeps, app: App, release: APIApplicationRelease): Promise<void> {
  try {
    const { content } = await getReleaseLog(deps.client, app.id, release.id);
    if (content === null) {
      void vscode.window.showInformationMessage(vscode.l10n.t("This log has expired."));
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content, language: "log" });
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err) {
    deps.showError(err);
  }
}

async function manageRollbacks(deps: CommandDeps, arg: unknown): Promise<void> {
  const app = (await deps.resolveApp(arg))?.app;
  if (!app) {return;}
  const picked = await pickRelease(deps, app);
  if (!picked) {return;}
  const { release, all } = picked;

  const rollbackLabel = vscode.l10n.t("Roll back to this version");
  const logLabel = vscode.l10n.t("View crash log");
  const copyLabel = vscode.l10n.t("Copy version ID");
  const actions = [
    ...(release.rollback.available ? [rollbackLabel] : []),
    ...(release.has_log ? [logLabel] : []),
    copyLabel,
  ];
  const action = await vscode.window.showQuickPick(actions, { title: releaseTitle(release, all) });
  if (action === rollbackLabel) {return rollBack(deps, app, release, all);}
  if (action === logLabel) {return viewLog(deps, app, release);}
  if (action === copyLabel) {
    await vscode.env.clipboard.writeText(release.id);
    void vscode.window.showInformationMessage(vscode.l10n.t("Version ID copied."));
  }
}

export function registerReleasesCommands(deps: CommandDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.app.rollbacks", (arg: unknown) => manageRollbacks(deps, arg)),
  );
}
