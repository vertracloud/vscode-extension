import * as vscode from "vscode";
import type { APICustomImage, APICustomImageApp } from "@vertracloud/api-types/v1";
import { listImages } from "../api/images";
import type { ApiClient } from "../api/client";
import { describeError, formatBytes, type ApiErrorLike } from "../l10n";
import type { Store } from "../state";

export interface ImageRef {
  image: APICustomImage;
  /** Presente quando a imagem é de um workspace. */
  workspaceId?: string;
}

export type ImageInfoField = "status" | "description" | "error" | "size" | "github" | "id";

export type ImageNode =
  | { kind: "workspace"; workspaceId: string; name: string }
  | ({ kind: "image" } & ImageRef)
  | ({ kind: "imageInfo"; field: ImageInfoField } & ImageRef)
  | ({ kind: "imageApps" } & ImageRef)
  | ({ kind: "imageApp"; app: APICustomImageApp } & ImageRef);

const REFRESH_INTERVAL_MS = 5_000;
const ERROR_LABEL_MAX = 100;

function toErrorLike(err: unknown): ApiErrorLike {
  if (err && typeof err === "object" && "code" in err) {return err as ApiErrorLike;}
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) };
}

export function imageStatusLabel(status: APICustomImage["status"]): string {
  switch (status) {
    case "building":
      return vscode.l10n.t("Building");
    case "failed":
      return vscode.l10n.t("Failed");
    default:
      return vscode.l10n.t("Ready");
  }
}

function imageIcon(status: APICustomImage["status"]): vscode.ThemeIcon {
  if (status === "building") {return new vscode.ThemeIcon("loading~spin");}
  if (status === "failed") {return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));}
  return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
}

export function imageContextValue(image: APICustomImage): string {
  let value = `image:${image.status}`;
  if (image.owner === "system") {value += ":system";}
  if (image.github) {value += ":github";}
  if (image.apps.length > 0) {value += ":apps";}
  return value;
}

function appsLabel(count: number): string {
  return count === 1 ? vscode.l10n.t("1 app") : vscode.l10n.t("{0} apps", count);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.length > ERROR_LABEL_MAX ? `${line.slice(0, ERROR_LABEL_MAX - 1)}…` : line;
}

/** Texto puro: o erro do build e o nome vêm de fora e nunca viram Markdown (links de comando). */
function imageTooltip(image: APICustomImage): string {
  const lines = [image.name, `ID: ${image.id}`, `${vscode.l10n.t("Status")}: ${imageStatusLabel(image.status)}`];
  if (image.description) {lines.push(`${vscode.l10n.t("Description")}: ${image.description}`);}
  if (image.digest) {lines.push(`${vscode.l10n.t("Digest")}: ${image.digest.slice(0, 19)}`);}
  if (image.uncompressed_bytes !== null) {lines.push(`${vscode.l10n.t("Size")}: ${formatBytes(image.uncompressed_bytes)}`);}
  if (image.status === "failed" && image.error) {lines.push(image.error);}
  return lines.join("\n");
}

function infoFields(image: APICustomImage): ImageInfoField[] {
  const fields: ImageInfoField[] = ["status"];
  if (image.description) {fields.push("description");}
  if (image.status === "failed" && image.error) {fields.push("error");}
  if (image.uncompressed_bytes !== null) {fields.push("size");}
  if (image.github) {fields.push("github");}
  fields.push("id");
  return fields;
}

function infoItem(ref: ImageRef, field: ImageInfoField): vscode.TreeItem {
  const { image } = ref;
  switch (field) {
    case "status": {
      const item = new vscode.TreeItem(vscode.l10n.t("Status: {0}", imageStatusLabel(image.status)), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("pulse");
      return item;
    }
    case "description": {
      const item = new vscode.TreeItem(vscode.l10n.t("Description: {0}", image.description ?? ""), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("note");
      item.tooltip = image.description ?? undefined;
      return item;
    }
    case "error": {
      const item = new vscode.TreeItem(vscode.l10n.t("Error: {0}", firstLine(image.error ?? "")), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      item.tooltip = image.error ?? undefined;
      item.command = { command: "vertraCloud.images.showBuildLog", title: "", arguments: [{ kind: "image", ...ref }] };
      return item;
    }
    case "size": {
      const size = formatBytes(image.uncompressed_bytes ?? 0);
      const label = image.layer_count !== null
        ? vscode.l10n.t("Size: {0} · {1} layers", size, image.layer_count)
        : vscode.l10n.t("Size: {0}", size);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("package");
      return item;
    }
    case "github": {
      const item = new vscode.TreeItem(
        vscode.l10n.t("GitHub: {0}", `${image.github?.repository ?? ""}@${image.github?.branch ?? ""}`),
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon("github");
      return item;
    }
    case "id": {
      const item = new vscode.TreeItem(vscode.l10n.t("ID: {0}", image.id), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("key");
      item.command = { command: "vertraCloud.copyId", title: "", arguments: [image.id] };
      return item;
    }
  }
}

export class ImagesProvider implements vscode.TreeDataProvider<ImageNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Seam de teste: intervalo do refresh enquanto algum build roda. */
  refreshIntervalMs = REFRESH_INTERVAL_MS;
  /** Preenchido quando a última listagem da conta falhou; o registrador mostra como mensagem da view. */
  message: string | undefined;
  onMessage?: (message: string | undefined) => void;
  /** `true` quando não há imagem nem workspace: a view mostra o texto de boas-vindas. */
  onEmpty?: (empty: boolean) => void;

  private visible = true;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Por escopo (conta ou id de workspace): a última listagem tinha build rodando. */
  private readonly building = new Map<string, boolean>();
  private lastWorkspaceSignature: string;
  private readonly storeSubscription: vscode.Disposable | undefined;

  constructor(
    private readonly getClient: () => ApiClient,
    private readonly store: Pick<Store, "workspaces" | "onDidChange">,
  ) {
    this.lastWorkspaceSignature = this.workspaceSignature();
    this.storeSubscription = this.store.onDidChange(() => {
      // O store dispara a cada poll de status; só uma mudança nos workspaces refaz a árvore.
      const signature = this.workspaceSignature();
      if (signature === this.lastWorkspaceSignature) {return;}
      this.lastWorkspaceSignature = signature;
      this.refresh();
    });
  }

  private workspaceSignature(): string {
    return this.store.workspaces.map((w) => w.id).join(",");
  }

  refresh(): void {
    this.emitter.fire();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {this.scheduleRefresh();}
    else {this.clearTimer();}
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.storeSubscription?.dispose();
    this.emitter.dispose();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleRefresh(): void {
    if (this.disposed || !this.visible || this.timer) {return;}
    if (![...this.building.values()].some(Boolean)) {return;}
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, this.refreshIntervalMs);
  }

  private async load(workspaceId?: string): Promise<APICustomImage[]> {
    const images = await listImages(this.getClient(), { workspaceId });
    this.building.set(workspaceId ?? "", images.some((image) => image.status === "building"));
    this.scheduleRefresh();
    return images;
  }

  /** Imagens da conta e de cada workspace, para quem escolhe uma imagem pela paleta de comandos. Falha de um escopo não derruba os outros. */
  async listAll(): Promise<ImageRef[]> {
    const refs: ImageRef[] = [];
    const personal = await this.load();
    refs.push(...personal.map((image) => ({ image })));
    const perWorkspace = await Promise.all(
      this.store.workspaces.map(async (workspace) => {
        try {
          return (await this.load(workspace.id)).map((image): ImageRef => ({ image, workspaceId: workspace.id }));
        } catch {
          return [];
        }
      }),
    );
    for (const group of perWorkspace) {refs.push(...group);}
    return refs;
  }

  getTreeItem(node: ImageNode): vscode.TreeItem {
    switch (node.kind) {
      case "workspace": {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon("organization");
        item.contextValue = "images:workspace";
        return item;
      }
      case "image": {
        const { image } = node;
        const item = new vscode.TreeItem(image.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = [imageStatusLabel(image.status), image.apps.length > 0 ? appsLabel(image.apps.length) : undefined].filter(Boolean).join(" · ");
        item.iconPath = imageIcon(image.status);
        item.contextValue = imageContextValue(image);
        item.tooltip = imageTooltip(image);
        return item;
      }
      case "imageInfo":
        return infoItem(node, node.field);
      case "imageApps": {
        const item = new vscode.TreeItem(vscode.l10n.t("Applications ({0})", node.image.apps.length), vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon("server-process");
        return item;
      }
      case "imageApp": {
        const item = new vscode.TreeItem(node.app.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("symbol-event");
        if (node.app.outdated) {
          item.description = vscode.l10n.t("newer version available");
          item.tooltip = vscode.l10n.t("The image has a newer version. Restart or deploy this application to use it.");
        }
        return item;
      }
    }
  }

  async getChildren(node?: ImageNode): Promise<ImageNode[]> {
    if (!node) {return this.roots();}
    switch (node.kind) {
      case "workspace":
        try {
          return (await this.load(node.workspaceId)).map((image): ImageNode => ({ kind: "image", image, workspaceId: node.workspaceId }));
        } catch {
          // Sem acesso ou sem o recurso naquele workspace: a árvore só fica sem imagens ali.
          return [];
        }
      case "image": {
        const ref: ImageRef = { image: node.image, workspaceId: node.workspaceId };
        const children: ImageNode[] = infoFields(node.image).map((field): ImageNode => ({ kind: "imageInfo", field, ...ref }));
        if (node.image.apps.length > 0) {
          // As aplicações entram antes do ID, que fica por último.
          children.splice(children.length - 1, 0, { kind: "imageApps", ...ref });
        }
        return children;
      }
      case "imageApps":
        return node.image.apps.map((app): ImageNode => ({ kind: "imageApp", app, image: node.image, workspaceId: node.workspaceId }));
      default:
        return [];
    }
  }

  private async roots(): Promise<ImageNode[]> {
    let images: APICustomImage[];
    try {
      images = await this.load();
    } catch (error) {
      this.setMessage(describeError(toErrorLike(error)));
      this.onEmpty?.(false);
      return [];
    }
    this.setMessage(undefined);
    const workspaces = this.store.workspaces;
    this.onEmpty?.(images.length === 0 && workspaces.length === 0);
    return [
      ...images.map((image): ImageNode => ({ kind: "image", image })),
      ...workspaces.map((workspace): ImageNode => ({ kind: "workspace", workspaceId: workspace.id, name: workspace.name })),
    ];
  }

  private setMessage(message: string | undefined): void {
    if (message === this.message) {return;}
    this.message = message;
    this.onMessage?.(message);
  }
}
