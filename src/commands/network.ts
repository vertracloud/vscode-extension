import * as vscode from "vscode";
import type { APIApplicationDnsRecord } from "@vertracloud/api-types/v1";
import {
  addAppCustomDomain,
  getAppCustomDomain,
  getAppDnsRecords,
  publishApp,
  purgeAppCache,
  removeAppCustomDomain,
  setAppSubdomain,
  unpublishApp,
} from "../api/network";
import type { CommandDeps } from "./deps";

const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

async function confirmSimple(message: string, confirmLabel: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
  return choice === confirmLabel;
}

async function publish(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}

  const subdomain = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Subdomain (optional)"),
    placeHolder: vscode.l10n.t("Leave empty to get a random subdomain on the Pro plan"),
    validateInput: (value) => {
      if (value.length === 0) {return undefined;}
      if (value.length < 3 || value.length > 50 || !SUBDOMAIN_PATTERN.test(value)) {
        return vscode.l10n.t("Use 3-50 lowercase letters, numbers and hyphens, not at the edges.");
      }
      return undefined;
    },
  });
  if (subdomain === undefined) {return;}

  try {
    const result = await publishApp(deps.client, entry.app.id, subdomain ? { subdomain } : {});
    await deps.refresh();
    const host = result.custom_domain ?? result.subdomain;
    if (host) {
      const url = `https://${host}`;
      const openLabel = vscode.l10n.t("Open");
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t("Application published at {0}", url),
        openLabel,
      );
      if (choice === openLabel) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  } catch (err) {
    deps.showError(err);
  }
}

async function unpublish(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}

  const confirmed = await confirmSimple(
    vscode.l10n.t("Unpublish \"{0}\"? It will no longer be reachable on the web.", entry.app.name),
    vscode.l10n.t("Unpublish"),
  );
  if (!confirmed) {return;}

  try {
    await unpublishApp(deps.client, entry.app.id);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

async function setSubdomain(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}

  const subdomain = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New subdomain"),
    validateInput: (value) => {
      if (value.length < 3 || value.length > 50 || !SUBDOMAIN_PATTERN.test(value)) {
        return vscode.l10n.t("Use 3-50 lowercase letters, numbers and hyphens, not at the edges.");
      }
      return undefined;
    },
  });
  if (!subdomain) {return;}

  try {
    await setAppSubdomain(deps.client, entry.app.id, subdomain);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

async function readCustomDomainHost(deps: CommandDeps, appId: string): Promise<string | undefined> {
  try {
    const custom = await getAppCustomDomain(deps.client, appId);
    return custom.domain;
  } catch {
    return undefined;
  }
}

async function addCustomDomain(deps: CommandDeps, appId: string): Promise<void> {
  const domain = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Custom domain"),
    placeHolder: "app.example.com",
    validateInput: (value) => {
      if (value.length < 1 || value.length > 253) {
        return vscode.l10n.t("The domain must be between 1 and 253 characters.");
      }
      return undefined;
    },
  });
  if (!domain) {return;}

  try {
    await addAppCustomDomain(deps.client, appId, domain);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

async function removeCustomDomain(deps: CommandDeps, appId: string, domain: string): Promise<void> {
  const confirmed = await confirmSimple(
    vscode.l10n.t("Remove custom domain \"{0}\"?", domain),
    vscode.l10n.t("Remove"),
  );
  if (!confirmed) {return;}

  try {
    await removeAppCustomDomain(deps.client, appId);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

function recordLabel(record: APIApplicationDnsRecord): string {
  return `${record.type} ${record.name}`;
}

async function showDns(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}
  const appId = entry.app.id;

  let records: APIApplicationDnsRecord[];
  try {
    records = await getAppDnsRecords(deps.client, appId);
  } catch (err) {
    deps.showError(err);
    return;
  }

  const customDomain = await readCustomDomainHost(deps, appId);
  const title = customDomain
    ? vscode.l10n.t("DNS — {0} ({1})", entry.app.name, customDomain)
    : vscode.l10n.t("DNS — {0}", entry.app.name);

  type Item =
    | { label: string; description: string; detail: string; record: APIApplicationDnsRecord; action?: undefined }
    | { label: string; action: "add" | "remove"; record?: undefined };

  const recordItems: Item[] = records.map((record) => ({
    label: recordLabel(record),
    description: record.status,
    detail: record.value,
    record,
  }));
  const domainItem: Item = customDomain
    ? { label: `$(trash) ${vscode.l10n.t("Remove custom domain")}`, action: "remove" }
    : { label: `$(add) ${vscode.l10n.t("Add custom domain…")}`, action: "add" };
  const items: Item[] = [...recordItems, domainItem];

  const picked = await vscode.window.showQuickPick(items, { title });
  if (!picked) {return;}

  if (picked.action === "add") {
    await addCustomDomain(deps, appId);
    return;
  }
  if (picked.action === "remove") {
    await removeCustomDomain(deps, appId, customDomain ?? "");
    return;
  }
  if (!picked.record) {return;}
  await vscode.env.clipboard.writeText(picked.record.value);
  void vscode.window.showInformationMessage(vscode.l10n.t("Value copied to clipboard."));
}

async function purgeCache(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}

  const confirmed = await confirmSimple(
    vscode.l10n.t("Purge the edge cache for \"{0}\"?", entry.app.name),
    vscode.l10n.t("Purge cache"),
  );
  if (!confirmed) {return;}

  try {
    await purgeAppCache(deps.client, entry.app.id, {});
    void vscode.window.showInformationMessage(vscode.l10n.t("Cache purge requested."));
  } catch (err) {
    deps.showError(err);
  }
}

export function registerNetworkCommands(deps: CommandDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.app.publish", (arg: unknown) => publish(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.app.unpublish", (arg: unknown) => unpublish(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.app.setSubdomain", (arg: unknown) => setSubdomain(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.app.showDns", (arg: unknown) => showDns(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.app.purgeCache", (arg: unknown) => purgeCache(deps, arg)),
  );
}
