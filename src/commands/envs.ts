import * as vscode from "vscode";
import type { APIApplicationEnvironment } from "@vertracloud/api-types/v1";
import { deleteAppEnv, getAppEnvs, upsertAppEnv } from "../api/envs";
import type { CommandDeps } from "./deps";

const MASKED_VALUE = "••••••";
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function manageEnvs(deps: CommandDeps, arg: unknown): Promise<void> {
  const entry = await deps.resolveApp(arg);
  if (!entry) {return;}
  const appId = entry.app.id;

  for (;;) {
    let envs: APIApplicationEnvironment[];
    try {
      envs = await getAppEnvs(deps.client, appId);
    } catch (err) {
      deps.showError(err);
      return;
    }

    const addItem = { label: `$(add) ${vscode.l10n.t("Add variable")}`, action: "add" as const };
    const envItems = envs.map((env) => ({
      label: env.key,
      description: env.note ?? undefined,
      detail: MASKED_VALUE,
      action: "select" as const,
      envId: env.id,
    }));

    const picked = await vscode.window.showQuickPick([addItem, ...envItems], {
      placeHolder: vscode.l10n.t("Environment variables"),
    });
    if (!picked) {return;}

    if (picked.action === "add") {
      await addEnv(deps, appId);
      continue;
    }

    const env = envs.find((e) => e.id === picked.envId);
    if (!env) {continue;}
    const done = await manageOneEnv(deps, appId, env);
    if (!done) {return;}
  }
}

async function addEnv(deps: CommandDeps, appId: string): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Variable name"),
    validateInput: (value) => {
      if (value.length < 1 || value.length > 255 || !KEY_PATTERN.test(value)) {
        return vscode.l10n.t("Use only letters, numbers and underscore, starting with a letter or underscore.");
      }
      return undefined;
    },
  });
  if (key === undefined) {return;}

  const value = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Value"),
    password: true,
    validateInput: (v) => {
      if (v.length < 1 || v.length > 3072) {
        return vscode.l10n.t("The value must be between 1 and 3072 characters.");
      }
      return undefined;
    },
  });
  if (value === undefined) {return;}

  try {
    await upsertAppEnv(deps.client, appId, { key, value });
  } catch (err) {
    deps.showError(err);
  }
}

/** Retorna `false` quando o usuário fechou o fluxo por completo (não só voltou pra lista). */
async function manageOneEnv(
  deps: CommandDeps,
  appId: string,
  env: APIApplicationEnvironment,
): Promise<boolean> {
  const actions = [
    { label: vscode.l10n.t("Reveal value"), action: "reveal" as const },
    { label: vscode.l10n.t("Edit value"), action: "editValue" as const },
    { label: vscode.l10n.t("Edit note"), action: "editNote" as const },
    { label: vscode.l10n.t("Delete"), action: "delete" as const },
  ];
  const picked = await vscode.window.showQuickPick(actions, { placeHolder: env.key });
  if (!picked) {return true;}

  switch (picked.action) {
    case "reveal": {
      const choice = await vscode.window.showInformationMessage(
        `${env.key}: ${env.value}`,
        { modal: true },
        vscode.l10n.t("Copy"),
      );
      if (choice === vscode.l10n.t("Copy")) {
        await vscode.env.clipboard.writeText(env.value);
      }
      return true;
    }
    case "editValue": {
      const value = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Value"),
        password: true,
        validateInput: (v) => {
          if (v.length < 1 || v.length > 3072) {
            return vscode.l10n.t("The value must be between 1 and 3072 characters.");
          }
          return undefined;
        },
      });
      if (value === undefined) {return true;}
      try {
        await upsertAppEnv(deps.client, appId, { key: env.key, value, note: env.note });
      } catch (err) {
        deps.showError(err);
      }
      return true;
    }
    case "editNote": {
      const note = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Note"),
        value: env.note ?? "",
        validateInput: (v) => {
          if (v.length > 50) {return vscode.l10n.t("The note must be at most 50 characters.");}
          return undefined;
        },
      });
      if (note === undefined) {return true;}
      try {
        await upsertAppEnv(deps.client, appId, { key: env.key, value: env.value, note: note || null });
      } catch (err) {
        deps.showError(err);
      }
      return true;
    }
    case "delete": {
      const confirmed = await deps.confirmDanger(env.key, vscode.l10n.t("delete this variable"));
      if (!confirmed) {return true;}
      try {
        await deleteAppEnv(deps.client, appId, env.id);
      } catch (err) {
        deps.showError(err);
      }
      return true;
    }
    default:
      return true;
  }
}

export function registerEnvsCommands(deps: CommandDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.app.manageEnvs", (arg: unknown) => manageEnvs(deps, arg)),
  );
}
