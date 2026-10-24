import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { createAppFromFolder, deployToApp, type CreateAppFields, type CreateAppResult } from "../deploy/deploy";
import { readConfig, writeConfigKey } from "../project/config";
import { runProjectChecks, showChecks } from "../project/checks";
import { link, pickFolder, unlink } from "../project/link";
import { buildErrorHint } from "../l10n";
import type { CommandDeps } from "./deps";
import { register } from "./index";
import { downloadApp } from "../api/snapshots";
import { getImage } from "../api/images";
import { isImageApp, summarizeImageCommit } from "../images/app";
import { findDockerfileRoot, planAllowsImages } from "../images/dockerfile";
import type { AppEntry } from "../state";
import { extractInto } from "../deploy/pull";

const DEFAULT_MEMORY = 512;

/** Assunto do último commit git da pasta, para pré-preencher a mensagem do deploy. Sem git ou sem repo = vazio. */
function lastGitSubject(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["log", "-1", "--format=%s"], { cwd, timeout: 3000 }, (err, stdout) => resolve(err ? "" : stdout.trim()));
  });
}

/** Mensagem do deploy no histórico (aba Rollbacks). Vazio = sem mensagem; Esc (undefined) cancela o deploy. */
async function askMessage(root: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: vscode.l10n.t("Deploy message"),
    prompt: vscode.l10n.t("Shown in the Rollbacks history. Leave it empty to deploy without one."),
    value: await lastGitSubject(root),
    ignoreFocusOut: true,
    validateInput: (value: string) => (value.length > 500 ? vscode.l10n.t("Up to 500 characters.") : undefined),
  });
}

/** Asks for the values `POST /v1/apps` requires and writes them to `vertracloud.config`. */
export async function createConfigInteractive(folderUri: vscode.Uri): Promise<Record<string, string> | undefined> {
  const existing = (await readConfig(folderUri))?.values ?? {};

  const name = await vscode.window.showInputBox({
    title: vscode.l10n.t("Application name"),
    value: existing.NAME,
    ignoreFocusOut: true,
    validateInput: (value: string) => (value.trim() ? undefined : vscode.l10n.t("The name can't be empty.")),
  });
  if (!name) {return undefined;}

  const main = await vscode.window.showInputBox({
    title: vscode.l10n.t("Entry point file"),
    value: existing.MAIN ?? "index.js",
    ignoreFocusOut: true,
    validateInput: (value: string) => (value.trim() ? undefined : vscode.l10n.t("The entry point can't be empty.")),
  });
  if (!main) {return undefined;}

  const memoryInput = await vscode.window.showInputBox({
    title: vscode.l10n.t("Memory in MB"),
    value: existing.MEMORY ?? String(DEFAULT_MEMORY),
    ignoreFocusOut: true,
    validateInput: (value: string) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) && parsed >= 100 ? undefined : vscode.l10n.t("Use an integer of at least 100.");
    },
  });
  if (!memoryInput) {return undefined;}

  const version = await vscode.window.showInputBox({
    title: vscode.l10n.t("Runtime version"),
    value: existing.VERSION ?? "recommended",
    ignoreFocusOut: true,
  });
  if (!version) {return undefined;}

  const values: Record<string, string> = {
    ...existing,
    NAME: name.trim(),
    MAIN: main.trim(),
    MEMORY: String(Number.parseInt(memoryInput, 10)),
    VERSION: version.trim(),
  };
  for (const key of ["NAME", "MAIN", "MEMORY", "VERSION"]) {
    await writeConfigKey(folderUri, key, values[key]);
  }
  return values;
}

function fieldsFromConfig(values: Record<string, string>, subdomain?: string): CreateAppFields {
  return {
    name: values.NAME,
    memory: Number.parseInt(values.MEMORY, 10),
    main: values.MAIN,
    version: values.VERSION,
    start: values.START,
    build: values.BUILD,
    description: values.DESCRIPTION,
    subdomain: subdomain || values.SUBDOMAIN,
  };
}

/**
 * Subir arquivos para um app de imagem é um commit: os arquivos entram por cima do contexto atual e a
 * imagem, que pode ter outros apps, é rebuildada. Pede o ok antes de enviar qualquer coisa.
 */
async function confirmImageCommit(deps: CommandDeps, app: AppEntry["app"]): Promise<{ imageName?: string } | undefined> {
  if (!isImageApp(app)) {return {};}
  let count: number | undefined;
  let imageName: string | undefined;
  try {
    const image = await getImage(deps.client, app.custom_image.image_id);
    count = image.apps.length;
    imageName = image.name;
  } catch {
    // sem escopo ou imagem de workspace: segue sem a contagem
  }
  const detail = [
    vscode.l10n.t("The files go on top of the current build context of the image."),
    count === undefined ? undefined : vscode.l10n.t("The image is used by {0} application(s).", count),
    vscode.l10n.t("Only this one restarts, and only if you ask for a restart. The other applications keep their version until you restart or deploy them."),
  ].filter(Boolean).join(" ");
  const go = vscode.l10n.t("Deploy");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Deploying {0} rebuilds the Docker image it runs from.", app.name),
    { modal: true, detail },
    go,
  );
  return choice === go ? { imageName } : undefined;
}

export function registerProjectCommands(deps: CommandDeps): void {
  const { context } = deps;

  const askRestart = async (): Promise<boolean | undefined> => {
    const yes = vscode.l10n.t("Yes");
    const no = vscode.l10n.t("No");
    const choice = await vscode.window.showQuickPick([yes, no], {
      placeHolder: vscode.l10n.t("Restart after deploy?"),
    });
    if (choice === undefined) {return undefined;}
    return choice === yes;
  };

  const afterDeploy = (appId: string, appName: string, result?: unknown, imageName?: string): void => {
    const commit = summarizeImageCommit(result, imageName);
    if (commit) {
      const showBuild = vscode.l10n.t("Show build log");
      void Promise.resolve(vscode.window.showInformationMessage(commit.text, showBuild)).then((choice) => {
        if (choice === showBuild) {void vscode.commands.executeCommand("vertraCloud.images.showBuildLog", { imageId: commit.imageId });}
      });
      return;
    }
    const showLogs = vscode.l10n.t("Show logs");
    void Promise.resolve(
      vscode.window.showInformationMessage(vscode.l10n.t("Deployed {0}.", appName), showLogs),
    ).then((choice) => {
      if (choice === showLogs) {void vscode.commands.executeCommand("vertraCloud.app.showLogs", appId);}
    });
  };

  register(context, "vertraCloud.project.link", async () => {
    const folder = await pickFolder();
    if (!folder) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Open a folder first."));
      return;
    }
    const entry = await deps.pickApp();
    if (!entry) {return;}

    const writeOption = vscode.l10n.t("Write to vertracloud.config");
    const rememberOption = vscode.l10n.t("Only remember in this workspace");
    const choice = await vscode.window.showQuickPick([writeOption, rememberOption], {
      placeHolder: vscode.l10n.t("Where should the link be stored?"),
    });
    if (!choice) {return;}

    await link(folder, entry.app.id, { writeConfig: choice === writeOption, app: entry.app }, context.workspaceState);
    await deps.links.refresh();
  });

  register(context, "vertraCloud.project.unlink", async () => {
    const folder = await pickFolder();
    if (!folder) {return;}
    await unlink(folder, context.workspaceState);
    await deps.links.refresh();
  });

  const linkedTarget = async () => {
    const links = deps.links.links;
    if (links.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("This folder isn't linked to an application yet."));
      return undefined;
    }
    if (links.length === 1) {return links[0];}
    const folder = await pickFolder();
    return links.find((l) => l.folder.uri.toString() === folder?.uri.toString());
  };

  register(context, "vertraCloud.project.pull", async () => {
    const target = await linkedTarget();
    if (!target) {return;}
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(vscode.l10n.t("Trust this workspace to write files into it."));
      return;
    }
    const entry = deps.store.apps.find((e) => e.app.id === target.appId);
    const appName = entry?.app.name ?? target.appId;
    const confirmLabel = vscode.l10n.t("Pull");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Pull files from {0} into {1}? Local files with the same path will be overwritten.", appName, target.folder.name),
      { modal: true },
      confirmLabel,
    );
    if (choice !== confirmLabel) {return;}
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Pulling files from {0}...", appName) },
        async () => {
          const buffer = await downloadApp(deps.client, target.appId);
          return extractInto(Buffer.from(buffer), target.folder.uri.fsPath);
        },
      );
      void vscode.window.showInformationMessage(vscode.l10n.t("Pulled {0} files from {1}.", String(result.written), appName));
    } catch (err) {
      deps.showError(err);
    }
  });

  register(context, "vertraCloud.project.deploy", async () => {
    const target = await linkedTarget();
    if (!target) {return;}

    const entry = deps.store.apps.find((e) => e.app.id === target.appId);
    const commitContext = entry ? await confirmImageCommit(deps, entry.app) : {};
    if (!commitContext) {return;}
    const restart = await askRestart();
    if (restart === undefined) {return;}
    const message = await askMessage(target.folder.uri.fsPath);
    if (message === undefined) {return;}

    const appName = entry?.app.name ?? target.folder.name;
    let result: unknown;
    try {
      result = await deployToApp(deps.client, {
        appId: target.appId,
        appName,
        root: target.folder.uri.fsPath,
        restart,
        message,
      });
    } catch (err) {
      deps.showError(err);
      return;
    }

    afterDeploy(target.appId, appName, result, commitContext.imageName);
    deps.remoteFiles?.invalidateApp(target.appId);
    await deps.store.pollAfterMutation(target.appId, "up");
  });

  register(context, "vertraCloud.project.deployFolder", async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: vscode.l10n.t("Deploy this folder"),
    });
    const folderUri = picked?.[0];
    if (!folderUri) {return;}

    const configId = (await readConfig(folderUri))?.values.ID;
    if (configId) {
      const entry = deps.store.apps.find((e) => e.app.id === configId);
      const commitContext = entry ? await confirmImageCommit(deps, entry.app) : {};
      if (!commitContext) {return;}
      const restart = await askRestart();
      if (restart === undefined) {return;}
      const message = await askMessage(folderUri.fsPath);
      if (message === undefined) {return;}
      const appName = entry?.app.name ?? configId;
      let result: unknown;
      try {
        result = await deployToApp(deps.client, { appId: configId, appName, root: folderUri.fsPath, restart, message });
      } catch (err) {
        deps.showError(err);
        return;
      }
      afterDeploy(configId, appName, result, commitContext.imageName);
      await deps.store.pollAfterMutation(configId, "up");
      return;
    }

    const createOption = vscode.l10n.t("Create a new application");
    const confirm = await vscode.window.showQuickPick([createOption], {
      placeHolder: vscode.l10n.t("This folder isn't linked to an application."),
    });
    if (confirm !== createOption) {return;}

    // Atalho: pasta com Dockerfile em plano com imagens. Recusar (ou fechar o aviso) segue o app comum.
    if (planAllowsImages(deps.store.user)) {
      const dockerfileRoot = await findDockerfileRoot(folderUri.fsPath);
      if (dockerfileRoot) {
        const asImage = vscode.l10n.t("Create a Docker image from this folder");
        const asApp = vscode.l10n.t("Continue as a regular application");
        const choice = await vscode.window.showInformationMessage(
          vscode.l10n.t("This folder has a Dockerfile. Do you want to create a Docker image with it?"),
          { modal: true, detail: vscode.l10n.t("Several applications can then run from the image. Without it, the application is created from the detected language and the Dockerfile is ignored.") },
          asImage,
          asApp,
        );
        if (choice === asImage) {
          await vscode.commands.executeCommand("vertraCloud.images.create", vscode.Uri.file(dockerfileRoot));
          return;
        }
      }
    }

    let values = (await readConfig(folderUri))?.values;
    if (!values?.NAME || !values.MAIN || !values.MEMORY || !values.VERSION) {
      values = await createConfigInteractive(folderUri);
    }
    if (!values) {return;}

    const subdomain = await vscode.window.showInputBox({
      title: vscode.l10n.t("Subdomain (optional)"),
      value: values.SUBDOMAIN,
      ignoreFocusOut: true,
    });
    if (subdomain === undefined) {return;}

    let created: CreateAppResult;
    try {
      created = await createAppFromFolder(deps.client, {
        root: folderUri.fsPath,
        fields: fieldsFromConfig(values, subdomain.trim()),
      });
    } catch (err) {
      deps.showError(err);
      return;
    }

    await writeConfigKey(folderUri, "ID", created.id);
    if (created.status === "down") {
      const hint = buildErrorHint(created.last_build_error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Created {0}, but the build failed. Check the application logs.", created.name) +
          (hint ? ` ${hint}` : ""),
      );
    } else {
      void vscode.window.showInformationMessage(
        created.status === "building"
          ? vscode.l10n.t("Created {0}. It is still building in the background.", created.name)
          : vscode.l10n.t("Created {0}.", created.name),
      );
    }
    await deps.refresh();
  });

  register(context, "vertraCloud.project.createConfig", async () => {
    const folder = await pickFolder();
    if (!folder) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Open a folder first."));
      return;
    }
    await createConfigInteractive(folder.uri);
  });

  register(context, "vertraCloud.project.runChecks", async () => {
    const folder = await pickFolder();
    if (!folder) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Open a folder first."));
      return;
    }
    await showChecks(await runProjectChecks(folder));
  });
}
