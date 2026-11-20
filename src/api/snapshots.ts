import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { APIResourceSnapshot } from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";
import { ApiError, DESTRUCTIVE_TIMEOUT_MS } from "./client";
import { writeThroughTempFile } from "./download-file";

export type SnapshotScope = "applications" | "databases";

// REMOVER na publicação do api-types com o contrato de jobs de snapshot e subir a dependência da
// extensão (hoje 0.6.1): `SnapshotJobStatus`, `SnapshotJob` (= `APISnapshotJob`) e `SnapshotRestoreAccepted`
// (= `APISnapshotRestoreAccepted`) passam a vir de `@vertracloud/api-types/v1`.
export type SnapshotJobStatus = "queued" | "running" | "ready" | "skipped" | "failed";

export interface SnapshotJob {
  id: string;
  kind: "snapshot" | "restore";
  resource_id: string;
  status: SnapshotJobStatus;
  /** Código público do motivo, quando `failed` ou `skipped`. */
  reason?: string;
  /** O que o `reason` traz numa resposta direta (`required_bytes`, `max_bytes`...), quando tem. */
  details?: Record<string, unknown>;
  snapshot_id?: string;
  /** Só com o job em `running`. */
  progress?: { phase: "preparing" | "copying" | "finishing"; percent?: number; done_bytes?: number; total_bytes?: number; eta_seconds?: number };
}

/** Resposta do 202 de `POST .../restore`: o restore roda como job. */
export interface SnapshotRestoreAccepted {
  job_id: string;
  warning?: string;
}

/** 202 de `POST .../snapshots`: o snapshot ainda está sendo tirado; acompanhe `job_id`. */
export interface SnapshotCreateAccepted {
  job_id: string;
}

/** `POST .../snapshots`: 201 traz o snapshot, 202 traz o job. */
export type SnapshotCreateResult = APIResourceSnapshot | SnapshotCreateAccepted;

export function isSnapshotCreateAccepted(result: SnapshotCreateResult | undefined): result is SnapshotCreateAccepted {
  return result !== undefined && "job_id" in result && typeof result.job_id === "string";
}

const JOB_POLL_INTERVAL_MS = 2_000;
/** Teto de espera de um job (30 min, o mesmo dos SDKs e da CLI); o trabalho segue no servidor. */
const MAX_WAIT_MS = 30 * 60_000;

export interface WaitOptions {
  token?: vscode.CancellationToken;
  workspaceId?: string;
  intervalMs?: number;
  maxWaitMs?: number;
  /** Troca o `setTimeout` real (testes). */
  sleep?: (ms: number) => Promise<void>;
}

/** `workspaceId`: o workspace dono do recurso; a api só deixa o dono mexer nos snapshots sem ele. Vai em toda chamada do fluxo. */
export interface SnapshotScoped {
  workspaceId?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function listSnapshots(
  client: ApiClient,
  resourceId: string,
  scope: SnapshotScope,
  opts?: SnapshotScoped,
): Promise<APIResourceSnapshot[]> {
  return client.request<APIResourceSnapshot[]>(`/v1/users/${resourceId}/snapshots`, {
    query: { scope, workspace_id: opts?.workspaceId },
  });
}

export function createSnapshot(
  client: ApiClient,
  resourceId: string,
  scope: SnapshotScope,
  token?: vscode.CancellationToken,
  opts?: SnapshotScoped,
): Promise<SnapshotCreateResult> {
  return client.request<SnapshotCreateResult>(`/v1/users/${resourceId}/snapshots`, {
    method: "POST",
    query: { scope, workspace_id: opts?.workspaceId },
    timeoutMs: DESTRUCTIVE_TIMEOUT_MS,
    token,
  });
}

/**
 * Baixa o snapshot inteiro para a memória (e por um instante duas vezes): só para arquivo pequeno. Para um snapshot que pode ser
 * grande use `downloadSnapshotToFile`.
 */
export function downloadSnapshot(
  client: ApiClient,
  resourceId: string,
  snapshotId: string,
  scope: SnapshotScope,
  token?: vscode.CancellationToken,
  opts?: SnapshotScoped,
): Promise<ArrayBuffer> {
  // Sem prazo total: só estoura se o arquivo parar de chegar (`DOWNLOAD_INACTIVITY_MS`); `timeoutMs` vale até os cabeçalhos.
  return client.request<ArrayBuffer>(`/v1/users/${resourceId}/snapshots/${snapshotId}/download`, {
    query: { scope, workspace_id: opts?.workspaceId },
    raw: true,
    timeoutMs: DESTRUCTIVE_TIMEOUT_MS,
    token,
  });
}

/**
 * Baixa o snapshot direto para `dest` conforme os bytes chegam (memória constante, qualquer tamanho), por um arquivo temporário que
 * só ganha o nome final no fim; falha, inatividade ou cancelamento apagam o temporário. Mesmo prazo de inatividade do `downloadSnapshot`.
 * Devolve os bytes gravados.
 */
export function downloadSnapshotToFile(
  client: ApiClient,
  resourceId: string,
  snapshotId: string,
  scope: SnapshotScope,
  dest: string,
  token?: vscode.CancellationToken,
  opts?: SnapshotScoped,
): Promise<number> {
  return writeThroughTempFile(dest, async (sink) => {
    await client.request<undefined>(`/v1/users/${resourceId}/snapshots/${snapshotId}/download`, {
      query: { scope, workspace_id: opts?.workspaceId },
      raw: true,
      timeoutMs: DESTRUCTIVE_TIMEOUT_MS,
      token,
      sink,
    });
  });
}

export function restoreSnapshot(
  client: ApiClient,
  resourceId: string,
  snapshotId: string,
  scope: SnapshotScope,
  opts?: { restoreImageVersion?: boolean; workspaceId?: string },
): Promise<SnapshotRestoreAccepted> {
  return client.request<SnapshotRestoreAccepted>(
    `/v1/users/${resourceId}/snapshots/${snapshotId}/restore`,
    {
      method: "POST",
      query: { scope, workspace_id: opts?.workspaceId },
      // `restore_image_version` só existe para app de imagem.
      body: opts?.restoreImageVersion ? { restore_image_version: true } : undefined,
    },
  );
}

export function getSnapshotJob(
  client: ApiClient,
  resourceId: string,
  jobId: string,
  scope: SnapshotScope | undefined,
  token?: vscode.CancellationToken,
  opts?: SnapshotScoped,
): Promise<SnapshotJob> {
  return client.request<SnapshotJob>(`/v1/users/${resourceId}/snapshots/jobs/${jobId}`, {
    query: { scope, workspace_id: opts?.workspaceId },
    token,
  });
}

/**
 * Acompanha o job até acabar. Devolve o job em `ready`; `failed` e `skipped` viram `ApiError`
 * com o `reason` público como código, para o `describeError` traduzir.
 */
export async function waitForSnapshotJob(
  client: ApiClient,
  resourceId: string,
  jobId: string,
  scope: SnapshotScope | undefined,
  opts: WaitOptions & { onStatus?: (status: SnapshotJobStatus) => void } = {},
): Promise<SnapshotJob> {
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + (opts.maxWaitMs ?? MAX_WAIT_MS);
  for (;;) {
    if (opts.token?.isCancellationRequested) {throw new ApiError(0, "CANCELLED", "Request cancelled");}
    const job = await getSnapshotJob(client, resourceId, jobId, scope, opts.token, { workspaceId: opts.workspaceId });
    opts.onStatus?.(job.status);
    if (job.status === "ready") {return job;}
    if (job.status === "failed" || job.status === "skipped") {
      const fallback = job.kind === "snapshot" ? "SNAPSHOT_FAILED" : "SNAPSHOT_RESTORE_FAILED";
      throw new ApiError(409, job.reason ?? fallback, undefined, { ...job.details, job_id: job.id });
    }
    if (Date.now() >= deadline) {throw new ApiError(0, "TIMEOUT", "Request timed out");}
    await sleep(opts.intervalMs ?? JOB_POLL_INTERVAL_MS);
  }
}

/** Tira o snapshot manual do app, espera o job quando a api responde 202 e devolve o id do snapshot pronto. */
async function snapshotForDownload(
  client: ApiClient,
  id: string,
  opts: WaitOptions & { onPreparing?: () => void },
): Promise<string> {
  const created = await createSnapshot(client, id, "applications", opts.token, { workspaceId: opts.workspaceId });
  if (!isSnapshotCreateAccepted(created)) {return created.id;}
  opts.onPreparing?.();
  const job = await waitForSnapshotJob(client, id, created.job_id, "applications", opts);
  if (!job.snapshot_id) {throw new ApiError(404, "SNAPSHOT_NOT_FOUND", "Snapshot job is ready but has no snapshot");}
  return job.snapshot_id;
}

/**
 * Baixa o projeto inteiro: tira um snapshot manual (conta na cota de snapshots; a chave precisa de `snapshots:write` e
 * `snapshots:read`), espera o job quando a api responde 202 e baixa o zip desse snapshot. O arquivo não tem prazo total.
 * O zip fica inteiro na memória: para um projeto que pode ser grande use `downloadAppToFile`.
 */
export async function downloadApp(
  client: ApiClient,
  id: string,
  opts: WaitOptions & { onPreparing?: () => void } = {},
): Promise<ArrayBuffer> {
  const snapshotId = await snapshotForDownload(client, id, opts);
  return downloadSnapshot(client, id, snapshotId, "applications", opts.token, { workspaceId: opts.workspaceId });
}

/** Como `downloadApp`, mas grava o zip em `dest` conforme os bytes chegam (ver `downloadSnapshotToFile`). Devolve os bytes gravados. */
export async function downloadAppToFile(
  client: ApiClient,
  id: string,
  dest: string,
  opts: WaitOptions & { onPreparing?: () => void } = {},
): Promise<number> {
  const snapshotId = await snapshotForDownload(client, id, opts);
  return downloadSnapshotToFile(client, id, snapshotId, "applications", dest, opts.token, {
    workspaceId: opts.workspaceId,
  });
}

/**
 * Recusa escrever dentro de uma pasta do workspace enquanto ele não é confiável — o zip baixado
 * pode conter o próprio código do usuário, e um workspace não confiável não deve ganhar arquivo
 * novo silenciosamente.
 */
function isInsideUntrustedWorkspace(target: vscode.Uri): boolean {
  if (vscode.workspace.isTrusted) {return false;}
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((folder) => target.fsPath.startsWith(folder.uri.fsPath));
}

/** Pergunta onde salvar e grava `buffer` inteiro: só para arquivo pequeno (certificado, contexto de build). Para snapshot e app use `chooseSaveTarget` + `downloadToTarget`. */
export async function saveBufferInteractive(buffer: ArrayBuffer, suggestedName: string): Promise<boolean> {
  const target = await chooseSaveTarget(suggestedName);
  if (!target) {return false;}
  await vscode.workspace.fs.writeFile(target, new Uint8Array(buffer));
  return true;
}

/** Pergunta onde salvar (antes de baixar, para o download ir direto ao destino). `undefined` = cancelou ou o destino é recusado. */
export async function chooseSaveTarget(suggestedName: string): Promise<vscode.Uri | undefined> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(suggestedName),
    filters: { Zip: ["zip"] },
  });
  if (!target) {return undefined;}
  if (isInsideUntrustedWorkspace(target)) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Can't save inside an untrusted workspace folder. Choose another location or trust the workspace."),
    );
    return undefined;
  }
  return target;
}

/**
 * Corre `download` apontando para o caminho de `target`, em fluxo. Um destino que não é do disco local (sistema de arquivos virtual)
 * recebe o arquivo depois de baixado para uma pasta temporária, que some em seguida.
 */
export async function downloadToTarget(target: vscode.Uri, download: (dest: string) => Promise<unknown>): Promise<void> {
  if (target.scheme === "file") {
    await download(target.fsPath);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "vertra-download-"));
  try {
    const temp = join(dir, "download.zip");
    await download(temp);
    await vscode.workspace.fs.copy(vscode.Uri.file(temp), target, { overwrite: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
