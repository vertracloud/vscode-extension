import * as vscode from "vscode";
import type { APIApplicationDomain, APIApplicationDomainDnsRecord, RESTPostAPIApplicationDomainBody } from "@vertracloud/api-types/v1";
import {
  addAppDomain,
  getAppDomainDns,
  listAppDomains,
  publishApp,
  purgeAppCache,
  removeAppDomain,
  setAppSubdomain,
  unpublishApp,
} from "../api/network";
import { domainLabel } from "../domains";
import type { CommandDeps } from "./deps";

const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const PATH_PREFIX_PATTERN = /^(\/[A-Za-z0-9._~-]+)+$/;
const PATH_PREFIX_MAX = 128;

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
    const host = result.subdomain;
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

  const hasDomains = (entry.app.domains?.length ?? 0) > 0;
  const message = hasDomains
    ? vscode.l10n.t(
        "Unpublish \"{0}\"? It will no longer be reachable on the web, and all of its custom domains will be permanently removed. To use them again you will need to add them and validate the DNS again.",
        entry.app.name,
      )
    : vscode.l10n.t("Unpublish \"{0}\"? It will no longer be reachable on the web.", entry.app.name);
  const confirmed = await confirmSimple(message, vscode.l10n.t("Unpublish"));
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

const PORT_MIN = 1;
const PORT_MAX = 65535;

function validatePort(value: string): string | undefined {
  if (value.length === 0) {return undefined;}
  const port = Number(value);
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    return vscode.l10n.t("Use a port between 1 and 65535.");
  }
  return undefined;
}

function validatePathPrefix(value: string): string | undefined {
  if (value.length === 0) {return undefined;}
  const invalid =
    value.length > PATH_PREFIX_MAX ||
    !PATH_PREFIX_PATTERN.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..");
  if (invalid) {
    return vscode.l10n.t("Use segments like \"/api\": letters, numbers, \".\", \"_\", \"~\" and \"-\", up to 128 characters, no \".\" or \"..\" segments.");
  }
  return undefined;
}

async function pickDomain(deps: CommandDeps, appId: string, title: string): Promise<APIApplicationDomain | undefined> {
  let domains: APIApplicationDomain[];
  try {
    domains = await listAppDomains(deps.client, appId);
  } catch (err) {
    deps.showError(err);
    return undefined;
  }
  if (domains.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("This application has no custom domains."));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    domains.map((domain) => ({
      label: domainLabel(domain),
      description: `${domain.status} · SSL ${domain.ssl_status}`,
      domain,
    })),
    { title },
  );
  return picked?.domain;
}

async function showDomainDns(deps: CommandDeps, appId: string, domain: APIApplicationDomain): Promise<void> {
  let records: APIApplicationDomainDnsRecord[];
  try {
    records = await getAppDomainDns(deps.client, appId, domain.id);
  } catch (err) {
    deps.showError(err);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    records.map((record) => ({
      label: `${record.type} ${record.name}`,
      description: record.status,
      detail: record.value,
      record,
    })),
    { title: vscode.l10n.t("DNS — {0}", domain.hostname) },
  );
  if (!picked) {return;}
  await vscode.env.clipboard.writeText(picked.record.value);
  void vscode.window.showInformationMessage(vscode.l10n.t("Value copied to clipboard."));
}

async function showDns(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}
  const domain = await pickDomain(deps, entry.app.id, vscode.l10n.t("Select a domain"));
  if (!domain) {return;}
  await showDomainDns(deps, entry.app.id, domain);
}

async function addDomain(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}

  const hostname = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Custom domain"),
    placeHolder: "app.example.com",
    validateInput: (value) => {
      if (value.length < 1 || value.length > 253) {
        return vscode.l10n.t("The domain must be between 1 and 253 characters.");
      }
      return undefined;
    },
  });
  if (!hostname) {return;}

  const www = await vscode.window.showQuickPick(
    [
      { label: vscode.l10n.t("Yes"), value: true },
      { label: vscode.l10n.t("No"), value: false },
    ],
    { title: vscode.l10n.t("Also create the automatic www / root companion?") },
  );
  if (!www) {return;}

  const portText = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Port (optional)"),
    placeHolder: "80",
    validateInput: validatePort,
  });
  if (portText === undefined) {return;}

  const pathPrefix = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Path prefix (optional)"),
    placeHolder: "/api",
    validateInput: validatePathPrefix,
  });
  if (pathPrefix === undefined) {return;}

  const body: RESTPostAPIApplicationDomainBody = { hostname, www: www.value };
  if (portText) {body.port = Number(portText);}
  if (pathPrefix) {body.path_prefix = pathPrefix;}

  try {
    const created = await addAppDomain(deps.client, entry.app.id, body);
    await deps.refresh();
    const main = created.find((domain) => domain.hostname === hostname) ?? created[0];
    if (main) {await showDomainDns(deps, entry.app.id, main);}
  } catch (err) {
    deps.showError(err);
  }
}

async function removeDomain(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}
  const domain = await pickDomain(deps, entry.app.id, vscode.l10n.t("Select a domain to remove"));
  if (!domain) {return;}

  const message = domain.companion_of
    ? vscode.l10n.t("Remove domain \"{0}\"?", domain.hostname)
    : vscode.l10n.t("Remove domain \"{0}\"? Its automatic companion is removed too.", domain.hostname);
  const confirmed = await confirmSimple(message, vscode.l10n.t("Remove"));
  if (!confirmed) {return;}

  try {
    await removeAppDomain(deps.client, entry.app.id, domain.id);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
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
    vscode.commands.registerCommand("vertraCloud.app.addDomain", (arg: unknown) => addDomain(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.app.removeDomain", (arg: unknown) => removeDomain(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.app.showDns", (arg: unknown) => showDns(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.app.purgeCache", (arg: unknown) => purgeCache(deps, arg)),
  );
}
