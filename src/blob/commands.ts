import * as vscode from "vscode";
import type { APIBlobObject } from "@vertracloud/blob";
import type { CommandDeps } from "../commands/deps";
import { register } from "../commands/index";
import { BlobProvider, blobUri, objectName, type BlobNode } from "../views/blob";
import { createGetBlob, type GetBlob } from "./client";
import { describeBlobError, errorCodeOf, isBlobSpecific } from "./errors";
import { BlobFileSystemProvider, BLOB_SCHEME } from "./fs";
import { collectEntries, uploadEntries } from "./upload";

const TEXT_TYPES = new Set(["application/json", "application/xml", "application/javascript", "application/x-yaml", "application/yaml"]);

export function isPreviewable(contentType: string): boolean {
  return contentType.startsWith("image/") || contentType.startsWith("text/") || TEXT_TYPES.has(contentType.split(";")[0].trim());
}

export function normalizePrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

export function parseUriList(text: string): vscode.Uri[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => vscode.Uri.parse(line))
    .filter((uri) => uri.scheme !== BLOB_SCHEME);
}

function objectOf(arg: unknown): APIBlobObject | undefined {
  const node = arg as BlobNode | undefined;
  return node?.kind === "object" ? node.object : undefined;
}

function prefixOf(arg: unknown): string {
  const node = arg as BlobNode | undefined;
  if (node?.kind === "folder") {return node.prefix;}
  if (node?.kind === "object") {return node.object.path.slice(0, node.object.path.lastIndexOf("/") + 1);}
  return "";
}

function isUri(arg: unknown): arg is vscode.Uri {
  return !!arg && typeof arg === "object" && "scheme" in arg && "path" in arg;
}

export function showBlobError(deps: Pick<CommandDeps, "showError">, err: unknown): void {
  const code = errorCodeOf(err);
  if (code === "ABORTED") {return;}
  if (isBlobSpecific(code)) {
    void vscode.window.showErrorMessage(describeBlobError(err as { code: string }));
    return;
  }
  // Scope and plan errors get their "Open API keys" / "View plans" action from the shared handler.
  deps.showError(err);
}

export class BlobDropController implements vscode.TreeDragAndDropController<BlobNode> {
  readonly dragMimeTypes: string[] = [];
  readonly dropMimeTypes = ["text/uri-list"];

  constructor(private readonly upload: (uris: vscode.Uri[], prefix: string) => Promise<void>) {}

  async handleDrop(target: BlobNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const text = await dataTransfer.get("text/uri-list")?.asString();
    if (!text) {return;}
    const uris = parseUriList(text);
    if (uris.length > 0) {await this.upload(uris, prefixOf(target));}
  }
}

export function registerBlob(deps: CommandDeps, getBlob: GetBlob = createGetBlob(deps.session)): { provider: BlobProvider } {
  const { context } = deps;
  const provider = new BlobProvider(getBlob);

  const runUpload = async (uris: vscode.Uri[], prefix: string): Promise<void> => {
    try {
      const blob = await getBlob();
      const summary = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Uploading to Blob Storage"), cancellable: true },
        async (progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          const entries = await collectEntries(uris);
          const step = entries.length > 0 ? 100 / entries.length : 0;
          return uploadEntries(blob, entries, prefix, controller.signal, (entry) =>
            progress.report({ message: entry.rel, increment: step }),
          );
        },
      );
      provider.refresh();
      if (summary.uploaded + summary.skipped + summary.failed === 0) {return;}
      const message = vscode.l10n.t("{0} uploaded, {1} skipped (already exist), {2} failed.", summary.uploaded, summary.skipped, summary.failed);
      if (summary.failed > 0) {
        void vscode.window.showWarningMessage(message);
        showBlobError(deps, summary.firstError);
      } else {
        void vscode.window.showInformationMessage(message);
      }
    } catch (error) {
      showBlobError(deps, error);
    }
  };

  /** Runs a handler and turns any failure into the right message. */
  const guarded = (handler: (...args: unknown[]) => Promise<void>) => async (...args: unknown[]): Promise<void> => {
    try {
      await handler(...args);
    } catch (error) {
      showBlobError(deps, error);
    }
  };

  const fsProvider = new BlobFileSystemProvider(getBlob);
  context.subscriptions.push(
    fsProvider,
    vscode.workspace.registerFileSystemProvider(BLOB_SCHEME, fsProvider, { isCaseSensitive: true, isReadonly: true }),
  );

  const view = vscode.window.createTreeView("vertraCloudBlob", {
    treeDataProvider: provider,
    showCollapseAll: true,
    dragAndDropController: new BlobDropController(runUpload),
  });
  provider.onMessage = (message) => {
    view.message = message;
  };
  context.subscriptions.push(view as unknown as { dispose(): void }, deps.session.onDidChange(() => provider.refresh()));

  register(context, "vertraCloud.blob.refresh", () => provider.refresh());

  register(context, "vertraCloud.blob.upload", guarded(async (arg, all) => {
    if (isUri(arg)) {
      // From the Explorer: `arg` is the clicked item, `all` the whole selection.
      const uris = Array.isArray(all) && all.length > 0 ? (all as vscode.Uri[]) : [arg];
      const answer = await vscode.window.showInputBox({
        title: vscode.l10n.t("Upload to Blob Storage"),
        prompt: vscode.l10n.t("Folder in Blob Storage (leave empty for the root)"),
      });
      if (answer === undefined) {return;}
      await runUpload(uris, normalizePrefix(answer));
      return;
    }
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true });
    if (picked && picked.length > 0) {await runUpload(picked, prefixOf(arg));}
  }));

  register(context, "vertraCloud.blob.copyUrl", guarded(async (arg) => {
    const object = objectOf(arg);
    if (!object?.url) {return;}
    await vscode.env.clipboard.writeText(object.url);
    void vscode.window.showInformationMessage(vscode.l10n.t("URL copied."));
  }));

  register(context, "vertraCloud.blob.copyMarkdown", guarded(async (arg) => {
    const object = objectOf(arg);
    if (!object?.url) {return;}
    await vscode.env.clipboard.writeText(`![${objectName(object)}](${object.url})`);
    void vscode.window.showInformationMessage(vscode.l10n.t("Markdown link copied."));
  }));

  register(context, "vertraCloud.blob.tempLink", guarded(async (arg) => {
    const object = objectOf(arg);
    if (!object) {return;}
    const choice = await vscode.window.showQuickPick(
      [
        { label: vscode.l10n.t("10 minutes"), seconds: 600 },
        { label: vscode.l10n.t("1 hour"), seconds: 3600 },
        { label: vscode.l10n.t("24 hours"), seconds: 86400 },
      ],
      { placeHolder: vscode.l10n.t("How long should the link work?") },
    );
    if (!choice) {return;}
    const { url } = await (await getBlob()).downloadUrl(object.id, { expiresIn: choice.seconds });
    await vscode.env.clipboard.writeText(url);
    void vscode.window.showInformationMessage(vscode.l10n.t("Temporary link copied. It can't be revoked before it expires."));
  }));

  register(context, "vertraCloud.blob.preview", guarded(async (arg) => {
    const object = objectOf(arg);
    if (!object) {return;}
    if (isPreviewable(object.content_type)) {
      await vscode.commands.executeCommand("vscode.open", blobUri(object));
      return;
    }
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(objectName(object)) });
    if (!target) {return;}
    const { url } = await (await getBlob()).downloadUrl(object.id, { expiresIn: 60 });
    const response = await fetch(url);
    if (!response.ok) {throw Object.assign(new Error("download failed"), { code: "NETWORK_ERROR" });}
    await vscode.workspace.fs.writeFile(target, new Uint8Array(await response.arrayBuffer()));
    void vscode.window.showInformationMessage(vscode.l10n.t("File downloaded."));
  }));

  register(context, "vertraCloud.blob.rename", guarded(async (arg) => {
    const object = objectOf(arg);
    if (!object) {return;}
    const path = await vscode.window.showInputBox({
      title: vscode.l10n.t("Rename or move"),
      prompt: vscode.l10n.t("New path of the file"),
      value: object.path,
      validateInput: (value: string) => (value.trim() && !value.trim().startsWith("/") ? undefined : vscode.l10n.t("Enter a path without a leading slash.")),
    });
    if (!path || path.trim() === object.path) {return;}
    await (await getBlob()).move(object.id, path.trim());
    provider.refresh();
  }));

  register(context, "vertraCloud.blob.toggleVisibility", guarded(async (arg) => {
    const object = objectOf(arg);
    if (!object) {return;}
    const next = object.visibility === "public" ? "private" : "public";
    if (next === "public") {
      const yes = vscode.l10n.t("Make public");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("Anyone with the link will be able to open \"{0}\".", objectName(object)),
        { modal: true },
        yes,
      );
      if (choice !== yes) {return;}
    }
    await (await getBlob()).update(object.id, { visibility: next });
    provider.refresh();
  }));

  register(context, "vertraCloud.blob.delete", guarded(async (arg) => {
    const node = arg as BlobNode | undefined;
    if (node?.kind !== "object" && node?.kind !== "folder") {return;}
    const label = node.kind === "object" ? objectName(node.object) : node.prefix;
    const yes = vscode.l10n.t("Delete");
    const choice = await vscode.window.showWarningMessage(
      node.kind === "object"
        ? vscode.l10n.t("Delete \"{0}\"? This can't be undone.", label)
        : vscode.l10n.t("Delete everything under \"{0}\"? This can't be undone.", label),
      { modal: true },
      yes,
    );
    if (choice !== yes) {return;}
    const blob = await getBlob();
    if (node.kind === "object") {
      await blob.delete(node.object.id);
    } else {
      await blob.deleteMany({ prefix: node.prefix });
    }
    provider.refresh();
  }));

  return { provider };
}
