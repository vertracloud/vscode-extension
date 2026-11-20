import * as vscode from "vscode";
import type { APIResourceSnapshot } from "@vertracloud/api-types/v1";
import { formatBytes } from "../l10n";
import {
  chooseSaveTarget,
  createSnapshot,
  downloadSnapshotToFile,
  downloadToTarget,
  isSnapshotCreateAccepted,
  listSnapshots,
  restoreSnapshot,
  type SnapshotScope,
  waitForSnapshotJob,
} from "../api/snapshots";
import { ApiError } from "../api/client";
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
      const created = await createSnapshot(deps.client, resource.id, scope);
      // 202 `{ response: { job_id } }`: não é erro, o snapshot ainda está sendo tirado e entra na lista quando ficar pronto.
      void vscode.window.showInformationMessage(
        isSnapshotCreateAccepted(created)
          ? vscode.l10n.t("The snapshot is still being taken. It will show up in the list when it is ready.")
          : vscode.l10n.t("Snapshot created."),
      );
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
    const destination = await chooseSaveTarget(`${resource.name}-${snapshot.date.slice(0, 10)}.zip`);
    if (!destination) {return;}
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Downloading snapshot..."), cancellable: true },
        (_progress, token) =>
          downloadToTarget(destination, (dest) => downloadSnapshotToFile(deps.client, resource.id, snapshot.id, scope, dest, token)),
      );
    } catch (err) {
      deps.showError(err);
    }
    return;
  }

  const confirmed = await deps.confirmDanger(resource.name, restoreLabel, vscode.l10n.t("The current data will be replaced and this can't be undone. To keep a copy, create a snapshot first."));
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
    const accepted = await restoreSnapshot(deps.client, resource.id, snapshot.id, scope, { restoreImageVersion });
    if (accepted?.warning === "IMAGE_VERSION_NOT_FOUND") {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("The image version recorded in this snapshot no longer exists, so only the data was restored. The application stays on its current version."),
      );
    }
    if (accepted?.job_id) {
      const finished = await followRestore(deps, resource, scope, accepted.job_id);
      if (!finished) {
        await deps.refresh();
        return;
      }
    }
    void vscode.window.showInformationMessage(vscode.l10n.t("Snapshot restored for {0}.", resource.name));
    await deps.refresh();
    if (scope === "applications") {
      deps.remoteFiles?.invalidateApp(resource.id);
      await deps.store.pollAfterMutation(resource.id, "up");
    }
  } catch (err) {
    deps.showError(err);
  }
}

/** Barra de progresso até o job de restore acabar. `false` quando o usuário parou de acompanhar (o restore segue no servidor). */
async function followRestore(deps: CommandDeps, resource: Resource, scope: SnapshotScope, jobId: string): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Restoring snapshot of {0}...", resource.name),
        cancellable: true,
      },
      async (progress, token) => {
        await waitForSnapshotJob(deps.client, resource.id, jobId, scope, {
          token,
          onStatus: (status) =>
            progress.report({ message: status === "queued" ? vscode.l10n.t("Waiting to start") : vscode.l10n.t("Restoring") }),
        });
      },
    );
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === "CANCELLED") {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("The restore of {0} keeps running in the background.", resource.name),
      );
      return false;
    }
    throw err;
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
