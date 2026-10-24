import * as vscode from "vscode";
import type { APIResourceSnapshot } from "@vertracloud/api-types/v1";
import { formatBytes } from "../l10n";
import {
  createSnapshot,
  downloadSnapshot,
  listSnapshots,
  restoreSnapshot,
  saveBufferInteractive,
  type SnapshotScope,
} from "../api/snapshots";
import { isImageApp } from "../images/app";
import type { CommandDeps } from "./deps";

interface Resource {
  id: string;
  name: string;
  /** App que roda de uma imagem Docker: o restore pode voltar também a versão da imagem. */
  imageApp?: boolean;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(vscode.env.language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

async function pickSnapshot(
  deps: CommandDeps,
  resource: Resource,
  scope: SnapshotScope,
): Promise<APIResourceSnapshot | undefined> {
  let snapshots: APIResourceSnapshot[];
  try {
    snapshots = await listSnapshots(deps.client, resource.id, scope);
  } catch (err) {
    deps.showError(err);
    return undefined;
  }

  const createItem: vscode.QuickPickItem & { snapshot?: APIResourceSnapshot } = {
    label: `$(add) ${vscode.l10n.t("Create snapshot")}`,
  };
  const items = [
    createItem,
    ...snapshots.map((snapshot) => ({
      label: formatDate(snapshot.date),
      description: formatBytes(Number(snapshot.size)),
      detail: snapshot.id,
      snapshot,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Snapshots — {0}", resource.name),
    placeHolder: vscode.l10n.t("Select a snapshot"),
  });
  if (!picked) {return undefined;}
  if (!picked.snapshot) {
    try {
      await createSnapshot(deps.client, resource.id, scope);
      void vscode.window.showInformationMessage(vscode.l10n.t("Snapshot created."));
    } catch (err) {
      deps.showError(err);
    }
    return undefined;
  }
  return picked.snapshot;
}

async function handleSnapshot(
  deps: CommandDeps,
  resource: Resource,
  scope: SnapshotScope,
  snapshot: APIResourceSnapshot,
): Promise<void> {
  const downloadLabel = vscode.l10n.t("Download");
  const restoreLabel = vscode.l10n.t("Restore");
  const action = await vscode.window.showQuickPick([downloadLabel, restoreLabel], {
    title: formatDate(snapshot.date),
  });
  if (!action) {return;}

  if (action === downloadLabel) {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Downloading snapshot...") },
        async () => {
          const buffer = await downloadSnapshot(deps.client, resource.id, snapshot.id, scope);
          const suggested = `${resource.name}-${snapshot.date.slice(0, 10)}.zip`;
          await saveBufferInteractive(buffer, suggested);
        },
      );
    } catch (err) {
      deps.showError(err);
    }
    return;
  }

  const confirmed = await deps.confirmDanger(resource.name, restoreLabel);
  if (!confirmed) {return;}

  let restoreImageVersion = false;
  if (resource.imageApp) {
    const dataOnly = vscode.l10n.t("Restore the data only");
    const withVersion = vscode.l10n.t("Restore the data and go back to the image version of this snapshot");
    const mode = await vscode.window.showQuickPick([dataOnly, withVersion], {
      title: vscode.l10n.t("This application runs from a Docker image"),
      placeHolder: vscode.l10n.t("The data of /app always comes back. Do you also want the code of that moment?"),
    });
    if (!mode) {return;}
    restoreImageVersion = mode === withVersion;
  }

  try {
    const result = await restoreSnapshot(deps.client, resource.id, snapshot.id, scope, { restoreImageVersion });
    void vscode.window.showInformationMessage(
      result?.message || vscode.l10n.t("Snapshot restore started for {0}.", resource.name),
    );
    if (result?.warning === "IMAGE_VERSION_NOT_FOUND") {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("The image version recorded in this snapshot no longer exists, so only the data was restored. The application stays on its current version."),
      );
    }
    await deps.refresh();
    if (scope === "applications") {
      deps.remoteFiles?.invalidateApp(resource.id);
      await deps.store.pollAfterMutation(resource.id, "up");
    }
  } catch (err) {
    deps.showError(err);
  }
}

async function manageSnapshots(deps: CommandDeps, arg: unknown, scope: SnapshotScope): Promise<void> {
  let resource: Resource | undefined;
  if (scope === "applications") {
    const app = (await deps.resolveApp(arg))?.app;
    resource = app ? { id: app.id, name: app.name, imageApp: isImageApp(app) } : undefined;
  } else {
    resource = (await deps.resolveDatabase(arg))?.db;
  }
  if (!resource) {return;}

  const snapshot = await pickSnapshot(deps, resource, scope);
  if (!snapshot) {return;}
  await handleSnapshot(deps, resource, scope, snapshot);
}

export function registerSnapshotsCommands(deps: CommandDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.app.manageSnapshots", (arg: unknown) =>
      manageSnapshots(deps, arg, "applications"),
    ),
    vscode.commands.registerCommand("vertraCloud.db.manageSnapshots", (arg: unknown) =>
      manageSnapshots(deps, arg, "databases"),
    ),
  );
}
