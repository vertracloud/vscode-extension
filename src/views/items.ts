import * as vscode from "vscode";
import type { WorkspaceFolderColor } from "@vertracloud/api-types/v1";
import type { AppEntry, DbEntry } from "../state";
import { formatUptime, statusLabel, formatMegabytes } from "../l10n";

export type AppInfoField = "status" | "ram" | "cpu" | "uptime" | "domain" | "id";
export type DbInfoField = "status" | "engine" | "host" | "ram" | "id";

export function folderIcon(color: WorkspaceFolderColor | undefined): vscode.ThemeIcon {
  return new vscode.ThemeIcon("folder", color && color !== "neutral" ? new vscode.ThemeColor(`charts.${color}`) : undefined);
}

export function appEffectiveStatus(entry: AppEntry): "up" | "down" | "installing" {
  if (entry.status?.installing) {return "installing";}
  if (entry.status) {return entry.status.running ? "up" : "down";}
  return entry.app.status === "up" ? "up" : "down";
}

function appIcon(status: "up" | "down" | "installing"): vscode.ThemeIcon {
  if (status === "installing") {return new vscode.ThemeIcon("loading~spin");}
  if (status === "up") {return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));}
  return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));
}

function appContextValue(entry: AppEntry): string {
  const status = appEffectiveStatus(entry);
  let value = `app:${status}`;
  if (entry.favorite) {value += ":favorite";}
  if (entry.app.public_url) {value += ":published";}
  return value;
}

export function appRamLabel(entry: AppEntry): string {
  return entry.status ? `${entry.status.ram} / ${formatMegabytes(entry.app.ram)}` : `${formatMegabytes(entry.app.ram)}`;
}

export function appTreeItem(entry: AppEntry): vscode.TreeItem {
  const status = appEffectiveStatus(entry);
  const ramLabel = appRamLabel(entry);
  const item = new vscode.TreeItem(entry.app.name, vscode.TreeItemCollapsibleState.Collapsed);
  item.description = status === "up" ? ramLabel : status === "installing" ? `${statusLabel(status)} · ${ramLabel}` : statusLabel(status);
  item.iconPath = appIcon(status);
  item.contextValue = appContextValue(entry);
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${entry.app.name}**\n\n`);
  tooltip.appendMarkdown(`- ${vscode.l10n.t("Status")}: ${statusLabel(status)}\n`);
  tooltip.appendMarkdown(`- ID: \`${entry.app.id}\`\n`);
  tooltip.appendMarkdown(`- ${vscode.l10n.t("Language")}: ${entry.app.language}\n`);
  tooltip.appendMarkdown(`- RAM: ${ramLabel}\n`);
  tooltip.appendMarkdown(
    `- ${vscode.l10n.t("Public domain")}: ${entry.app.public_url ?? vscode.l10n.t("Not published")}\n`
  );
  tooltip.appendMarkdown(`- ${vscode.l10n.t("Uptime")}: ${formatUptime(entry.status?.uptime ?? null)}\n`);
  item.tooltip = tooltip;
  return item;
}

/** Campos exibidos como filhos de um app expandido; "cpu" só entra quando o status short chegou. */
export function appInfoFields(entry: AppEntry): AppInfoField[] {
  const fields: AppInfoField[] = ["status", "ram"];
  if (entry.status) {fields.push("cpu");}
  fields.push("uptime", "domain", "id");
  return fields;
}

export function appInfoItem(entry: AppEntry, field: AppInfoField): vscode.TreeItem {
  switch (field) {
    case "status": {
      const item = new vscode.TreeItem(
        vscode.l10n.t("Status: {0}", statusLabel(appEffectiveStatus(entry))),
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon("pulse");
      return item;
    }
    case "ram": {
      const item = new vscode.TreeItem(vscode.l10n.t("RAM: {0}", appRamLabel(entry)), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("server");
      return item;
    }
    case "cpu": {
      const item = new vscode.TreeItem(vscode.l10n.t("CPU: {0}", entry.status?.cpu ?? "?"), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("dashboard");
      return item;
    }
    case "uptime": {
      const item = new vscode.TreeItem(
        vscode.l10n.t("Uptime: {0}", formatUptime(entry.status?.uptime ?? null)),
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon("watch");
      return item;
    }
    case "domain": {
      const domain = entry.app.public_url ?? vscode.l10n.t("Not published");
      const item = new vscode.TreeItem(vscode.l10n.t("Domain: {0}", domain), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("globe");
      if (entry.app.public_url) {
        item.command = { command: "vertraCloud.app.open", title: "", arguments: [entry.app.id] };
      }
      return item;
    }
    case "id": {
      const item = new vscode.TreeItem(vscode.l10n.t("ID: {0}", entry.app.id), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("key");
      item.command = { command: "vertraCloud.copyId", title: "", arguments: [entry.app.id] };
      return item;
    }
  }
}

export function dbTreeItem(entry: DbEntry): vscode.TreeItem {
  const up = entry.status ? entry.status.running : entry.db.status === "up";
  const item = new vscode.TreeItem(entry.db.name, vscode.TreeItemCollapsibleState.Collapsed);
  const ramLabel = entry.status ? `${entry.status.ram} / ${formatMegabytes(entry.db.ram)}` : `${formatMegabytes(entry.db.ram)}`;
  item.description = `${entry.db.type} · ${ramLabel}`;
  item.iconPath = up
    ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
    : new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));
  item.contextValue = `db:${up ? "up" : "down"}${entry.favorite ? ":favorite" : ""}`;
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${entry.db.name}**\n\n`);
  tooltip.appendMarkdown(`- ${vscode.l10n.t("Status")}: ${statusLabel(up ? "up" : "down")}\n`);
  tooltip.appendMarkdown(`- ID: \`${entry.db.id}\`\n`);
  tooltip.appendMarkdown(`- ${vscode.l10n.t("Engine")}: ${entry.db.type}\n`);
  tooltip.appendMarkdown(`- ${vscode.l10n.t("Host")}: ${entry.db.host}:${entry.db.port}\n`);
  tooltip.appendMarkdown(`- RAM: ${ramLabel}\n`);
  if (entry.status) {tooltip.appendMarkdown(`- ${vscode.l10n.t("Storage")}: ${entry.status.storage}\n`);}
  item.tooltip = tooltip;
  return item;
}

export function dbInfoFields(): DbInfoField[] {
  return ["status", "engine", "host", "ram", "id"];
}

export function dbInfoItem(entry: DbEntry, field: DbInfoField): vscode.TreeItem {
  const up = entry.status ? entry.status.running : entry.db.status === "up";
  switch (field) {
    case "status": {
      const item = new vscode.TreeItem(vscode.l10n.t("Status: {0}", statusLabel(up ? "up" : "down")), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("pulse");
      return item;
    }
    case "engine": {
      const item = new vscode.TreeItem(vscode.l10n.t("Engine: {0}", entry.db.type), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("database");
      return item;
    }
    case "host": {
      const item = new vscode.TreeItem(vscode.l10n.t("Host: {0}", `${entry.db.host}:${entry.db.port}`), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("server-environment");
      return item;
    }
    case "ram": {
      const ramLabel = entry.status ? `${entry.status.ram} / ${formatMegabytes(entry.db.ram)}` : `${formatMegabytes(entry.db.ram)}`;
      const item = new vscode.TreeItem(vscode.l10n.t("RAM: {0}", ramLabel), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("server");
      return item;
    }
    case "id": {
      const item = new vscode.TreeItem(vscode.l10n.t("ID: {0}", entry.db.id), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("key");
      item.command = { command: "vertraCloud.copyId", title: "", arguments: [entry.db.id] };
      return item;
    }
  }
}
