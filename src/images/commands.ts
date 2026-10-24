import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { APICustomImage, APICustomImageVersion, APIDockerfileCheck } from "@vertracloud/api-types/v1";
import { ApiError } from "../api/client";
import {
  buildImageAppBody,
  buildImageForm,
  checkDockerfile,
  createAppFromImage,
  createImage,
  deleteImage,
  getImage,
  getImageContext,
  linkImageGithub,
  listImageVersions,
  openImageLogStream,
  rebuildImage,
  unlinkImageGithub,
  updateImage,
} from "../api/images";
import { saveBufferInteractive } from "../api/snapshots";
import type { CommandDeps } from "../commands/deps";
import { register } from "../commands/index";
import { ImagesProvider, type ImageNode, type ImageRef } from "../views/images";
import { collectImageContext, contextFileList, packImageContext, type ImageContext } from "./context";
import { formatIssues } from "./issues";
import { readImageLog } from "./logs";
import { chooseImagePort, parsePort, PortHints } from "./ports";

const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** A branch is optional: empty means the repository's default branch; otherwise no spaces. */
function validateOptionalBranch(value: string): string | undefined {
  const branch = value.trim();
  return !branch || !/\s/.test(branch) ? undefined : vscode.l10n.t("Enter a branch name without spaces.");
}
const IMAGE_NAME_MAX = 50;
const IMAGE_DESCRIPTION_MAX = 128;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_MEMORY = 512;
/** Sem build rodando o servidor repete o histórico e pode ficar aberto: a CLI também espera 3 s sem linha nova. */
const LOG_IDLE_MS = 3000;

function isUri(arg: unknown): arg is vscode.Uri {
  return !!arg && typeof arg === "object" && "scheme" in arg && "fsPath" in arg;
}

/** Nó da árvore (imagem, detalhe ou app da imagem) ou qualquer objeto com `image` e `workspaceId`. */
export function imageRefOf(arg: unknown): ImageRef | undefined {
  if (!arg || typeof arg !== "object") {return undefined;}
  const node = arg as Partial<ImageNode> & { image?: APICustomImage; workspaceId?: string };
  if (node.image && typeof node.image.id === "string") {
    return { image: node.image, workspaceId: typeof node.workspaceId === "string" ? node.workspaceId : undefined };
  }
  return undefined;
}

function workspaceOf(arg: unknown): string | undefined {
  if (!arg || typeof arg !== "object") {return undefined;}
  const id = (arg as { workspaceId?: unknown }).workspaceId;
  return typeof id === "string" ? id : undefined;
}

function notTrusted(): ApiError {
  return new ApiError(
    0,
    "WORKSPACE_NOT_TRUSTED",
    vscode.l10n.t("Building images from a folder is disabled in restricted (untrusted) workspace mode."),
  );
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Mostra o resultado da checagem. Recusa bloqueia; aviso pede confirmação. Devolve `true` para seguir. */
export async function reviewDockerfileCheck(check: APIDockerfileCheck): Promise<boolean> {
  if (check.refusals.length > 0) {
    await vscode.window.showErrorMessage(
      vscode.l10n.t("The Dockerfile has instructions the platform refuses."),
      { modal: true, detail: formatIssues(check.refusals).join("\n") },
    );
    return false;
  }
  if (check.warnings.length > 0) {
    const go = vscode.l10n.t("Build anyway");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("The Dockerfile has warnings."),
      { modal: true, detail: formatIssues(check.warnings).join("\n") },
      go,
    );
    return choice === go;
  }
  return true;
}

async function pickContextFolder(arg: unknown): Promise<string | undefined> {
  if (isUri(arg) && arg.scheme === "file") {return arg.fsPath;}
  const folders = vscode.workspace.workspaceFolders ?? [];
  const browse = (): Promise<string | undefined> =>
    Promise.resolve(
      vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t("Use this folder"),
      }),
    ).then((picked) => picked?.[0]?.fsPath);
  if (folders.length === 0) {return browse();}
  const browseLabel = `$(folder-opened) ${vscode.l10n.t("Browse...")}`;
  const picked = await vscode.window.showQuickPick(
    [
      ...folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, fsPath: folder.uri.fsPath as string | undefined })),
      { label: browseLabel, description: undefined, fsPath: undefined },
    ],
    { placeHolder: vscode.l10n.t("Folder with the Dockerfile at its root") },
  );
  if (!picked) {return undefined;}
  return picked.fsPath ?? browse();
}

export function registerImages(deps: CommandDeps): { provider: ImagesProvider } {
  const { context } = deps;
  const provider = new ImagesProvider(() => deps.client, deps.store);
  const hints = new PortHints(context.workspaceState);

  const view = vscode.window.createTreeView("vertraCloudImages", { treeDataProvider: provider, showCollapseAll: true });
  provider.onMessage = (message) => {
    view.message = message;
  };
  provider.onEmpty = (empty) => {
    void vscode.commands.executeCommand("setContext", "vertraCloud.imagesEmpty", empty);
  };
  const channels = new Map<string, vscode.OutputChannel>();
  const following = new Map<string, AbortController>();
  context.subscriptions.push(
    view as unknown as { dispose(): void },
    view.onDidChangeVisibility((e: { visible: boolean }) => provider.setVisible(e.visible)),
    deps.session.onDidChange(() => provider.refresh()),
    provider,
    {
      dispose: () => {
        for (const controller of following.values()) {controller.abort();}
        following.clear();
        for (const channel of channels.values()) {channel.dispose();}
        channels.clear();
      },
    },
  );

  const guarded = (handler: (...args: unknown[]) => Promise<void>) => async (...args: unknown[]): Promise<void> => {
    try {
      await handler(...args);
    } catch (error) {
      deps.showError(error);
    }
  };

  const scopeOf = (ref: ImageRef) => ({ workspaceId: ref.workspaceId });

  const resolveImage = async (arg: unknown): Promise<ImageRef | undefined> => {
    const direct = imageRefOf(arg);
    if (direct) {return direct;}
    // Vem de outro comando (deploy de app de imagem): só o id da imagem; o resto vem da API.
    const byId = (arg as { imageId?: unknown } | undefined)?.imageId;
    if (typeof byId === "string") {
      const workspaceId = workspaceOf(arg);
      return { image: await getImage(deps.client, byId, { workspaceId }), workspaceId };
    }
    const all = await provider.listAll();
    if (all.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No Docker images available."));
      return undefined;
    }
    if (all.length === 1) {return all[0];}
    const workspaceNames = new Map(deps.store.workspaces.map((w) => [w.id, w.name]));
    const picked = await vscode.window.showQuickPick(
      all.map((ref) => ({
        label: ref.image.name,
        description: ref.workspaceId ? workspaceNames.get(ref.workspaceId) : undefined,
        detail: ref.image.id,
        ref,
      })),
      { placeHolder: vscode.l10n.t("Select a Docker image") },
    );
    return picked?.ref;
  };

  /** Imagem do sistema é da plataforma: ninguém muda nem apaga. */
  const requireOwn = (ref: ImageRef): boolean => {
    if (ref.image.owner !== "system") {return true;}
    void vscode.window.showInformationMessage(vscode.l10n.t("This image is provided by the platform and can't be changed."));
    return false;
  };

  const pickScope = async (arg: unknown): Promise<{ workspaceId?: string } | undefined> => {
    const given = workspaceOf(arg);
    if (given) {return { workspaceId: given };}
    if (arg !== undefined && arg !== null && typeof arg === "object" && !isUri(arg)) {return {};}
    const workspaces = deps.store.workspaces;
    if (workspaces.length === 0) {return {};}
    const personal = { label: vscode.l10n.t("My account"), workspaceId: undefined as string | undefined };
    const picked = await vscode.window.showQuickPick(
      [personal, ...workspaces.map((w) => ({ label: w.name, workspaceId: w.id as string | undefined }))],
      { placeHolder: vscode.l10n.t("Who owns the image?") },
    );
    return picked ? { workspaceId: picked.workspaceId } : undefined;
  };

  const showBuildLog = async (ref: ImageRef, versionId?: string): Promise<void> => {
    const key = `${ref.image.id}:${versionId ?? "latest"}`;
    let channel = channels.get(key);
    if (!channel) {
      channel = vscode.window.createOutputChannel(
        versionId
          ? vscode.l10n.t("Vertra Cloud: image {0} (version log)", ref.image.name)
          : vscode.l10n.t("Vertra Cloud: image {0} (build)", ref.image.name),
      );
      channels.set(key, channel);
    }
    channel.show(true);
    if (following.has(key)) {return;}
    // Reserva a chave antes de qualquer await: dois cliques seguidos não abrem dois streams.
    const controller = new AbortController();
    following.set(key, controller);

    try {
      await streamBuildLog(ref, versionId, controller, channel);
    } finally {
      following.delete(key);
      provider.refresh();
    }
  };

  const streamBuildLog = async (ref: ImageRef, versionId: string | undefined, controller: AbortController, channel: vscode.OutputChannel): Promise<void> => {
    // Estado fresco decide se segue ao vivo ou só repete o histórico.
    let building = ref.image.status === "building";
    try {
      building = (await getImage(deps.client, ref.image.id, scopeOf(ref))).status === "building";
    } catch {
      // segue com o estado que a árvore tinha
    }

    channel.clear();
    const body = await openImageLogStream(deps.client, ref.image.id, { versionId, workspaceId: ref.workspaceId, signal: controller.signal });
    const end = await vscode.window.withProgress(
      {
        location: building ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
        title: vscode.l10n.t("Following the build log of {0}", ref.image.name),
        cancellable: building,
      },
      async (_progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        return readImageLog(body, {
          controller,
          idleMs: building ? undefined : LOG_IDLE_MS,
          onLine: (line) => channel.appendLine(line),
        });
      },
    );
    if (end === "interrupted") {channel.appendLine(`[Vertra] ${vscode.l10n.t("The connection to the build log was interrupted.")}`);}
    else if (end === "ended") {channel.appendLine(`[Vertra] ${vscode.l10n.t("End of the build log.")}`);}
  };

  const afterBuildStarted = (image: APICustomImage, ref: { workspaceId?: string }, message: string): void => {
    provider.refresh();
    const show = vscode.l10n.t("Show build log");
    void Promise.resolve(vscode.window.showInformationMessage(message, show)).then((choice) => {
      if (choice === show) {void showBuildLog({ image, workspaceId: ref.workspaceId });}
    });
  };

  /** Lê a pasta e roda a checagem do Dockerfile; recusa bloqueia e aviso pede confirmação. */
  const prepareFolder = async (root: string): Promise<{ ctx: ImageContext; check: APIDockerfileCheck } | undefined> => {
    if (!vscode.workspace.isTrusted) {throw notTrusted();}
    const prepared = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Checking the Dockerfile"), cancellable: true },
      async (_progress, token) => {
        const ctx = await collectImageContext(root, { token });
        if (token.isCancellationRequested) {throw new ApiError(0, "CANCELLED", "Cancelled");}
        const check = await checkDockerfile(deps.client, { dockerfile: ctx.dockerfile, files: contextFileList(ctx) });
        return { ctx, check };
      },
    );
    if (!(await reviewDockerfileCheck(prepared.check))) {return undefined;}
    return prepared;
  };

  /** Empacota o contexto e envia; apaga o zip temporário em qualquer desfecho. */
  const sendContext = async <T>(
    ctx: ImageContext,
    title: string,
    send: (file: { bytes: Uint8Array; filename: string }, token: vscode.CancellationToken) => Promise<T>,
  ): Promise<T> =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      progress.report({ message: vscode.l10n.t("Compressing") });
      const zip = await packImageContext(ctx, token);
      try {
        if (token.isCancellationRequested) {throw new ApiError(0, "CANCELLED", "Cancelled");}
        progress.report({ message: vscode.l10n.t("Uploading") });
        const bytes = await fs.readFile(zip.path);
        return await send({ bytes, filename: `${path.basename(ctx.root) || "context"}.zip` }, token);
      } finally {
        await zip.cleanup();
      }
    });

  // --- view -----------------------------------------------------------------------------------

  register(context, "vertraCloud.images.refresh", () => provider.refresh());

  register(context, "vertraCloud.images.create", guarded(async (arg) => {
    const scope = await pickScope(arg);
    if (!scope) {return;}
    let source: "folder" | "github" | undefined = isUri(arg) ? "folder" : undefined;
    if (!source) {
      const folderLabel = `$(folder) ${vscode.l10n.t("A folder of this computer")}`;
      const githubLabel = `$(github) ${vscode.l10n.t("A GitHub repository")}`;
      const picked = await vscode.window.showQuickPick([folderLabel, githubLabel], { placeHolder: vscode.l10n.t("Where is the Dockerfile?") });
      if (!picked) {return;}
      source = picked === folderLabel ? "folder" : "github";
    }

    let root: string | undefined;
    let github: { repository: string; branch?: string } | undefined;
    if (source === "folder") {
      root = await pickContextFolder(arg);
      if (!root) {return;}
    }
    const name = await vscode.window.showInputBox({
      title: vscode.l10n.t("Image name"),
      value: root ? path.basename(root) : undefined,
      ignoreFocusOut: true,
      validateInput: (value: string) => (value.trim() ? undefined : vscode.l10n.t("The name can't be empty.")),
    });
    if (!name?.trim()) {return;}
    if (source === "github") {
      const repository = await vscode.window.showInputBox({
        title: vscode.l10n.t("GitHub repository"),
        prompt: vscode.l10n.t("Repository as owner/name"),
        ignoreFocusOut: true,
        validateInput: (value: string) => (REPOSITORY_PATTERN.test(value.trim()) ? undefined : vscode.l10n.t("Use the format owner/name.")),
      });
      if (!repository) {return;}
      const branch = await vscode.window.showInputBox({
        title: vscode.l10n.t("Branch"),
        prompt: vscode.l10n.t("Optional. Leave it empty to use the repository's default branch."),
        ignoreFocusOut: true,
        validateInput: validateOptionalBranch,
      });
      if (branch === undefined) {return;}
      github = { repository: repository.trim(), branch: branch.trim() || undefined };
    }

    let image: APICustomImage;
    if (root) {
      const prepared = await prepareFolder(root);
      if (!prepared) {return;}
      image = await sendContext(prepared.ctx, vscode.l10n.t("Creating image {0}", name.trim()), (file, token) =>
        createImage(deps.client, buildImageForm({ name: name.trim(), workspaceId: scope.workspaceId, file }), token),
      );
      await hints.set(image.id, prepared.check.suggested_port);
    } else {
      image = await createImage(deps.client, buildImageForm({ name: name.trim(), workspaceId: scope.workspaceId, github }));
    }
    afterBuildStarted(image, scope, vscode.l10n.t("Image {0} created. The build is running in the background.", image.name));
  }));

  register(context, "vertraCloud.images.rename", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (!ref || !requireOwn(ref)) {return;}
    const typed = await vscode.window.showInputBox({
      title: vscode.l10n.t("Rename image {0}", ref.image.name),
      prompt: vscode.l10n.t("Nothing is rebuilt and your applications keep running."),
      value: ref.image.name,
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        const name = value.trim();
        return name && name.length <= IMAGE_NAME_MAX ? undefined : vscode.l10n.t("The name must have 1 to 50 characters.");
      },
    });
    const name = typed?.trim();
    if (!name || name === ref.image.name) {return;}
    const updated = await updateImage(deps.client, ref.image.id, { name }, scopeOf(ref));
    provider.refresh();
    void vscode.window.showInformationMessage(vscode.l10n.t("Image {0} renamed to {1}.", ref.image.name, updated?.name ?? name));
  }));

  register(context, "vertraCloud.images.editDescription", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (!ref || !requireOwn(ref)) {return;}
    const current = ref.image.description ?? "";
    const typed = await vscode.window.showInputBox({
      title: vscode.l10n.t("Description of image {0}", ref.image.name),
      prompt: vscode.l10n.t("Up to 128 characters. Leave it empty to remove the description."),
      value: current,
      ignoreFocusOut: true,
      validateInput: (value: string) =>
        value.trim().length <= IMAGE_DESCRIPTION_MAX ? undefined : vscode.l10n.t("The description can have up to 128 characters."),
    });
    if (typed === undefined) {return;}
    const description = typed.trim();
    if (description === current) {return;}
    await updateImage(deps.client, ref.image.id, { description: description || null }, scopeOf(ref));
    provider.refresh();
    void vscode.window.showInformationMessage(
      description ? vscode.l10n.t("Description of {0} updated.", ref.image.name) : vscode.l10n.t("Description of {0} removed.", ref.image.name),
    );
  }));

  register(context, "vertraCloud.images.rebuild", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (!ref || !requireOwn(ref)) {return;}
    const fresh = await getImage(deps.client, ref.image.id, scopeOf(ref));
    if (fresh.status === "building") {
      throw new ApiError(409, "IMAGE_BUILD_IN_PROGRESS");
    }
    const root = await pickContextFolder(undefined);
    if (!root) {return;}
    const go = vscode.l10n.t("Rebuild");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Rebuild {0} from this folder?", fresh.name),
      {
        modal: true,
        detail: vscode.l10n.t("The folder replaces the whole build context. Applications keep running their current version until you restart or deploy them."),
      },
      go,
    );
    if (choice !== go) {return;}
    const prepared = await prepareFolder(root);
    if (!prepared) {return;}
    const image = await sendContext(prepared.ctx, vscode.l10n.t("Rebuilding image {0}", fresh.name), (file, token) =>
      rebuildImage(deps.client, fresh.id, buildImageForm({ file }), scopeOf(ref), token),
    );
    await hints.set(image.id, prepared.check.suggested_port);
    afterBuildStarted(image, ref, vscode.l10n.t("Rebuilding {0}. Your applications are not restarted.", image.name));
  }));

  register(context, "vertraCloud.images.showBuildLog", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (ref) {await showBuildLog(ref);}
  }));

  register(context, "vertraCloud.images.versions", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (!ref) {return;}
    const versions = await listImageVersions(deps.client, ref.image.id, scopeOf(ref));
    if (versions.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("This image has no versions yet."));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      versions.map((version) => ({
        label: `$(tag) ${formatDate(version.created_at)}`,
        description: [sourceLabel(version), version.in_use ? vscode.l10n.t("in use") : undefined].filter(Boolean).join(" · "),
        // A mensagem foi escrita por quem enviou o código: texto puro, nunca interpretado.
        detail: [version.message, version.digest.slice(0, 19)].filter(Boolean).join(" — "),
        version,
      })),
      { title: vscode.l10n.t("Versions of {0}", ref.image.name) },
    );
    if (!picked) {return;}
    const copyId = vscode.l10n.t("Copy version ID");
    const copyDigest = vscode.l10n.t("Copy digest");
    const log = vscode.l10n.t("Show the build log of this version");
    const action = await vscode.window.showQuickPick([log, copyId, copyDigest], { title: formatDate(picked.version.created_at) });
    if (action === log) {await showBuildLog(ref, picked.version.id);}
    if (action === copyId) {
      await vscode.env.clipboard.writeText(picked.version.id);
      void vscode.window.showInformationMessage(vscode.l10n.t("Version ID copied."));
    }
    if (action === copyDigest) {
      await vscode.env.clipboard.writeText(picked.version.digest);
      void vscode.window.showInformationMessage(vscode.l10n.t("Digest copied."));
    }
  }));

  register(context, "vertraCloud.images.downloadContext", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (!ref || !requireOwn(ref)) {return;}
    const { url } = await getImageContext(deps.client, ref.image.id, scopeOf(ref));
    if (!isHttps(url)) {
      throw new ApiError(0, "NETWORK_ERROR", "The download address is not https.");
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Downloading the build context of {0}", ref.image.name) },
      async () => {
        // Link temporário de armazenamento: sem credencial da conta.
        const response = await fetch(url);
        if (!response.ok) {throw new ApiError(response.status, "NETWORK_ERROR", `HTTP ${response.status}`);}
        const buffer = await response.arrayBuffer();
        await saveBufferInteractive(buffer, `${ref.image.name.replace(/[\\/:*?"<>|]/g, "_")}-context.zip`);
      },
    );
  }));

  register(context, "vertraCloud.images.linkGithub", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (!ref || !requireOwn(ref)) {return;}
    const repository = await vscode.window.showInputBox({
      title: vscode.l10n.t("Link GitHub repository"),
      prompt: vscode.l10n.t("Repository as owner/name, from your GitHub App installations. A push to the branch rebuilds the image."),
      value: ref.image.github?.repository,
      ignoreFocusOut: true,
      validateInput: (value: string) => (REPOSITORY_PATTERN.test(value.trim()) ? undefined : vscode.l10n.t("Use the format owner/name.")),
    });
    if (!repository) {return;}
    const branch = await vscode.window.showInputBox({
      title: vscode.l10n.t("Branch"),
      prompt: vscode.l10n.t("Optional. Leave it empty to use the repository's default branch."),
      value: ref.image.github?.branch,
      ignoreFocusOut: true,
      validateInput: validateOptionalBranch,
    });
    if (branch === undefined) {return;}
    const branchName = branch.trim() || undefined;
    const linked = await linkImageGithub(deps.client, ref.image.id, branchName ? { repository: repository.trim(), branch: branchName } : { repository: repository.trim() }, scopeOf(ref));
    provider.refresh();
    const linkedBranch = linked?.github?.branch ?? branchName;
    void vscode.window.showInformationMessage(
      vscode.l10n.t("{0} is linked to {1}.", ref.image.name, linkedBranch ? `${repository.trim()}@${linkedBranch}` : repository.trim()),
    );
  }));

  register(context, "vertraCloud.images.unlinkGithub", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (!ref || !requireOwn(ref)) {return;}
    if (!ref.image.github) {
      void vscode.window.showInformationMessage(vscode.l10n.t("This image isn't linked to GitHub."));
      return;
    }
    const go = vscode.l10n.t("Unlink");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Unlink {0} from {1}?", ref.image.name, `${ref.image.github.repository}@${ref.image.github.branch}`),
      { modal: true, detail: vscode.l10n.t("Pushes will no longer rebuild the image.") },
      go,
    );
    if (choice !== go) {return;}
    await unlinkImageGithub(deps.client, ref.image.id, scopeOf(ref));
    provider.refresh();
  }));

  register(context, "vertraCloud.images.delete", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (!ref || !requireOwn(ref)) {return;}
    // A árvore pode estar velha: contagem e nome vêm do servidor, como no rebuild.
    const fresh = await getImage(deps.client, ref.image.id, scopeOf(ref));
    const count = fresh.apps.length;
    const warning = count > 0
      ? vscode.l10n.t("Deleting this image also permanently deletes its {0} application(s), its versions and its build context. An API key also needs the apps:delete permission.", count)
      : vscode.l10n.t("Deleting this image permanently deletes its versions and its build context.");
    const go = vscode.l10n.t("Continue");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Delete the image {0}?", fresh.name),
      { modal: true, detail: warning },
      go,
    );
    if (choice !== go) {return;}
    if (!(await deps.confirmDanger(fresh.name, vscode.l10n.t("Delete image")))) {return;}
    const result = await deleteImage(deps.client, ref.image.id, fresh.name, scopeOf(ref));
    provider.refresh();
    await deps.refresh();
    const removed = result?.deleted_apps?.length ?? 0;
    void vscode.window.showInformationMessage(
      removed > 0
        ? vscode.l10n.t("Image {0} deleted, with {1} application(s).", fresh.name, removed)
        : vscode.l10n.t("Image {0} deleted.", fresh.name),
    );
  }));

  register(context, "vertraCloud.images.createApp", guarded(async (arg) => {
    const ref = await resolveImage(arg);
    if (!ref) {return;}
    if (ref.image.status !== "success") {
      throw new ApiError(409, "IMAGE_NOT_READY");
    }
    const name = await vscode.window.showInputBox({
      title: vscode.l10n.t("Application name"),
      value: ref.image.name,
      ignoreFocusOut: true,
      validateInput: (value: string) => (value.trim() ? undefined : vscode.l10n.t("The name can't be empty.")),
    });
    if (!name?.trim()) {return;}
    const memoryInput = await vscode.window.showInputBox({
      title: vscode.l10n.t("Memory in MB"),
      value: String(DEFAULT_MEMORY),
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed >= 100 ? undefined : vscode.l10n.t("Use an integer of at least 100.");
      },
    });
    if (!memoryInput) {return;}

    const yes = vscode.l10n.t("Yes, publish it on the web");
    const no = vscode.l10n.t("No, it has no web traffic (a bot or a worker)");
    const webChoice = await vscode.window.showQuickPick([yes, no], { placeHolder: vscode.l10n.t("Does the application serve web traffic?") });
    if (!webChoice) {return;}
    const web = webChoice === yes;

    let subdomain: string | undefined;
    let port: number | undefined;
    if (web) {
      subdomain = await vscode.window.showInputBox({
        title: vscode.l10n.t("Subdomain (optional)"),
        prompt: vscode.l10n.t("Leave empty to get a random subdomain"),
        ignoreFocusOut: true,
        validateInput: (value: string) => {
          if (value.length === 0) {return undefined;}
          return value.length < 3 || value.length > 50 || !SUBDOMAIN_PATTERN.test(value)
            ? vscode.l10n.t("Use 3-50 lowercase letters, numbers and hyphens, not at the edges.")
            : undefined;
        },
      });
      if (subdomain === undefined) {return;}
      const portInput = await vscode.window.showInputBox({
        title: vscode.l10n.t("Port the application listens on"),
        prompt: vscode.l10n.t("The platform sets it in the PORT variable and sends the traffic to it."),
        value: String(chooseImagePort({ api: ref.image.suggested_port, hint: hints.get(ref.image.id) })),
        ignoreFocusOut: true,
        validateInput: (value: string) => (parsePort(value) ? undefined : vscode.l10n.t("Use a port between 1 and 65535.")),
      });
      if (portInput === undefined) {return;}
      port = parsePort(portInput);
    }

    const envs: Array<{ key: string; value: string }> = [];
    for (;;) {
      const key = await vscode.window.showInputBox({
        title: vscode.l10n.t("Environment variable name"),
        prompt: vscode.l10n.t("Leave empty to finish. Variables are set on the application, never on the image."),
        ignoreFocusOut: true,
        validateInput: (value: string) => {
          if (value.length === 0) {return undefined;}
          if (value.length > 255 || !ENV_KEY_PATTERN.test(value)) {
            return vscode.l10n.t("Use only letters, numbers and underscore, starting with a letter or underscore.");
          }
          return envs.some((env) => env.key === value) ? vscode.l10n.t("This environment variable already exists.") : undefined;
        },
      });
      if (key === undefined) {return;}
      if (key === "") {break;}
      const value = await vscode.window.showInputBox({
        title: vscode.l10n.t("Value of {0}", key),
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {return;}
      envs.push({ key, value });
    }

    const body = buildImageAppBody({
      imageId: ref.image.id,
      name: name.trim(),
      memory: Number.parseInt(memoryInput, 10),
      web,
      subdomain,
      port,
      envs,
      workspaceId: ref.workspaceId,
    });
    const app = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Creating {0}", body.name) },
      () => createAppFromImage(deps.client, body),
    );
    provider.refresh();
    await deps.refresh();
    void vscode.window.showInformationMessage(vscode.l10n.t("Created {0}. It is still building in the background.", app.name));
    await deps.store.pollAfterMutation(app.id, "up");
  }));

  return { provider };
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(vscode.env.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function sourceLabel(version: APICustomImageVersion): string {
  switch (version.source) {
    case "commit":
      return vscode.l10n.t("commit");
    case "github":
      return vscode.l10n.t("GitHub push");
    default:
      return vscode.l10n.t("upload");
  }
}
