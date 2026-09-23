import { promises as fs } from "node:fs";
import type { APIApplication } from "@vertracloud/api-types/v1";
import * as vscode from "vscode";
import { ApiError } from "../api/client";
import { collectFiles, createZip, MAX_UPLOAD_BYTES } from "./zip";
import { loadIgnore } from "./ignore";

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Interface estrutural mínima do cliente HTTP: subir um arquivo não precisa do módulo inteiro.
 */
export interface UploadClient {
  request<T>(
    path: string,
    opts?: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      query?: Record<string, string | number | boolean | undefined>;
      form?: FormData;
      timeoutMs?: number;
      token?: vscode.CancellationToken;
    },
  ): Promise<T>;
}

function notTrustedError(): ApiError {
  return new ApiError(
    0,
    "WORKSPACE_NOT_TRUSTED",
    vscode.l10n.t("Deploy is disabled in restricted (untrusted) workspace mode."),
  );
}

function cancelledError(): ApiError {
  return new ApiError(0, "CANCELLED", vscode.l10n.t("Deploy cancelled."));
}

interface PreparedZip {
  path: string;
  size: number;
  cleanup(): Promise<void>;
}

async function prepareZip(
  root: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<PreparedZip> {
  progress.report({ message: vscode.l10n.t("Scanning files") });
  const ig = await loadIgnore(root);
  const { files } = await collectFiles(root, ig, { token });
  if (token.isCancellationRequested) {throw cancelledError();}

  progress.report({ message: vscode.l10n.t("Compressing") });
  return createZip(files, { token });
}

async function uploadForm(
  client: UploadClient,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  fields: Record<string, string | undefined>,
  zip: PreparedZip,
  token: vscode.CancellationToken,
): Promise<unknown> {
  // ponytail: 100 MB máx cabe em memória; streaming multipart pediria uma dependência nova.
  const buffer = await fs.readFile(zip.path);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {form.set(key, value);}
  }
  form.set("file", new Blob([buffer]), "deploy.zip");

  return client.request(path, {
    method: "POST",
    query,
    form,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    token,
  });
}

export interface DeployToAppOptions {
  appId: string;
  appName: string;
  root: string;
  restart: boolean;
  workspaceId?: string;
}

export async function deployToApp(client: UploadClient, opts: DeployToAppOptions): Promise<unknown> {
  if (!vscode.workspace.isTrusted) {throw notTrustedError();}

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Deploying {0}", opts.appName),
      cancellable: true,
    },
    async (progress, token) => {
      const zip = await prepareZip(opts.root, progress, token);
      try {
        if (token.isCancellationRequested) {throw cancelledError();}
        progress.report({ message: vscode.l10n.t("Uploading") });
        return await uploadForm(
          client,
          `/v1/apps/${opts.appId}/files/upload`,
          { restart: opts.restart ? "true" : "false", workspace_id: opts.workspaceId },
          {},
          zip,
          token,
        );
      } finally {
        await zip.cleanup();
      }
    },
  );
}

export interface CreateAppFields {
  name: string;
  memory: number;
  main: string;
  version: string;
  start?: string;
  build?: string;
  subdomain?: string;
  description?: string;
  workspace_id?: string;
}

export type CreateAppResult = APIApplication & {
  missing_dependencies?: string[];
  removed_directories?: string[];
};

export interface CreateAppFromFolderOptions {
  root: string;
  fields: CreateAppFields;
}

export async function createAppFromFolder(
  client: UploadClient,
  opts: CreateAppFromFolderOptions,
): Promise<CreateAppResult> {
  if (!vscode.workspace.isTrusted) {throw notTrustedError();}

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Creating {0}", opts.fields.name),
      cancellable: true,
    },
    async (progress, token) => {
      const zip = await prepareZip(opts.root, progress, token);
      try {
        if (token.isCancellationRequested) {throw cancelledError();}
        progress.report({ message: vscode.l10n.t("Uploading") });
        return (await uploadForm(
          client,
          "/v1/apps",
          {},
          {
            name: opts.fields.name,
            memory: String(opts.fields.memory),
            main: opts.fields.main,
            version: opts.fields.version,
            start: opts.fields.start,
            build: opts.fields.build,
            subdomain: opts.fields.subdomain,
            description: opts.fields.description,
            workspace_id: opts.fields.workspace_id,
          },
          zip,
          token,
        )) as CreateAppResult;
      } finally {
        await zip.cleanup();
      }
    },
  );
}

export { MAX_UPLOAD_BYTES };
