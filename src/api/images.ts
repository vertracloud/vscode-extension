import type {
  APIApplication,
  APICustomImage,
  APICustomImageVersion,
  APIDockerfileCheck,
  RESTDeleteAPICustomImageResult,
  RESTPatchAPICustomImageBody,
  RESTPostAPIApplicationImageBody,
  RESTPostAPICustomImageCheckBody,
} from "@vertracloud/api-types/v1";
import type * as vscode from "vscode";
import type { ApiClient } from "./client";

interface Scoped {
  workspaceId?: string;
}

const scope = (opts?: Scoped) => ({ workspace_id: opts?.workspaceId });
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const imagePath = (id: string, suffix = "") => `/v1/images/${encodeURIComponent(id)}${suffix}`;

type Success<T> = Extract<T, { response: unknown }>["response"];

export function listImages(client: ApiClient, opts?: Scoped): Promise<APICustomImage[]> {
  return client.request<APICustomImage[]>("/v1/images", { query: scope(opts) });
}

export function getImage(client: ApiClient, id: string, opts?: Scoped): Promise<APICustomImage> {
  return client.request<APICustomImage>(imagePath(id), { query: scope(opts) });
}

export function createImage(client: ApiClient, form: FormData, token?: vscode.CancellationToken): Promise<APICustomImage> {
  return client.request<APICustomImage>("/v1/images", { method: "POST", form, timeoutMs: UPLOAD_TIMEOUT_MS, token });
}

/** `PATCH /v1/images/:id`: renomeia e/ou muda a descrição, sem buildar. `description: null` remove. */
export function updateImage(
  client: ApiClient,
  id: string,
  body: RESTPatchAPICustomImageBody,
  opts?: Scoped,
): Promise<APICustomImage> {
  return client.request<APICustomImage>(imagePath(id), { method: "PATCH", body, query: scope(opts) });
}

export function rebuildImage(
  client: ApiClient,
  id: string,
  form: FormData,
  opts?: Scoped,
  token?: vscode.CancellationToken,
): Promise<APICustomImage> {
  return client.request<APICustomImage>(imagePath(id), {
    method: "PUT",
    form,
    query: scope(opts),
    timeoutMs: UPLOAD_TIMEOUT_MS,
    token,
  });
}

export function deleteImage(
  client: ApiClient,
  id: string,
  confirmName: string,
  opts?: Scoped,
): Promise<Success<RESTDeleteAPICustomImageResult>> {
  return client.request<Success<RESTDeleteAPICustomImageResult>>(imagePath(id), {
    method: "DELETE",
    body: { confirm_name: confirmName },
    query: scope(opts),
  });
}

export function listImageVersions(client: ApiClient, id: string, opts?: Scoped): Promise<APICustomImageVersion[]> {
  return client.request<APICustomImageVersion[]>(imagePath(id, "/versions"), { query: scope(opts) });
}

export function getImageContext(client: ApiClient, id: string, opts?: Scoped): Promise<{ url: string }> {
  return client.request<{ url: string }>(imagePath(id, "/context"), { query: scope(opts) });
}

export function linkImageGithub(
  client: ApiClient,
  id: string,
  body: { repository: string; branch?: string },
  opts?: Scoped,
): Promise<APICustomImage> {
  return client.request<APICustomImage>(imagePath(id, "/github"), { method: "PUT", body, query: scope(opts) });
}

export function unlinkImageGithub(client: ApiClient, id: string, opts?: Scoped): Promise<APICustomImage> {
  return client.request<APICustomImage>(imagePath(id, "/github"), { method: "DELETE", query: scope(opts) });
}

export function checkDockerfile(client: ApiClient, body: RESTPostAPICustomImageCheckBody): Promise<APIDockerfileCheck> {
  return client.request<APIDockerfileCheck>("/v1/images/check", { method: "POST", body });
}

export function createAppFromImage(client: ApiClient, body: RESTPostAPIApplicationImageBody): Promise<APIApplication> {
  return client.request<APIApplication>("/v1/apps/image", { method: "POST", body });
}

/** Stream SSE do log do build: repete o histórico e segue ao vivo. */
export function openImageLogStream(
  client: Pick<ApiClient, "stream">,
  id: string,
  opts: { versionId?: string; workspaceId?: string; signal: AbortSignal },
): Promise<ReadableStream<Uint8Array>> {
  return client.stream(imagePath(id, "/logs"), {
    query: { version_id: opts.versionId, workspace_id: opts.workspaceId },
    signal: opts.signal,
  });
}

// ---------------------------------------------------------------------------
// Corpos

export interface ImageFormInput {
  /** Só na criação: o rebuild não envia nome. */
  name?: string;
  workspaceId?: string;
  /** Origem 1: o zip do contexto. */
  file?: { bytes: Uint8Array; filename: string };
  /** Origem 2: repositório do GitHub (`owner/name`) e branch opcional (sem ela, vale a padrão do repositório). Exclusiva com `file`. */
  github?: { repository: string; branch?: string };
}

/** `multipart/form-data` de `POST /v1/images` e `PUT /v1/images/:id`: uma origem só, nunca as duas nem nenhuma. */
export function buildImageForm(input: ImageFormInput): FormData {
  if (Boolean(input.file) === Boolean(input.github)) {
    throw new Error("An image build needs exactly one source: a file or a GitHub repository.");
  }
  const form = new FormData();
  if (input.name !== undefined) {form.set("name", input.name);}
  if (input.workspaceId) {form.set("workspace_id", input.workspaceId);}
  if (input.file) {
    form.set("file", new Blob([new Uint8Array(input.file.bytes)]), input.file.filename);
  } else if (input.github) {
    form.set("github_repository", input.github.repository);
    if (input.github.branch) {form.set("github_branch", input.github.branch);}
  }
  return form;
}

export interface ImageAppInput {
  imageId: string;
  name: string;
  memory: number;
  web: boolean;
  description?: string;
  /** Vazio com web ligado = o sistema escolhe (`"random"`). */
  subdomain?: string;
  port?: number;
  envs: Array<{ key: string; value: string }>;
  workspaceId?: string;
}

/** Corpo de `POST /v1/apps/image`. Sem web não há subdomínio nem porta. */
export function buildImageAppBody(input: ImageAppInput): RESTPostAPIApplicationImageBody {
  const body: RESTPostAPIApplicationImageBody = {
    image_id: input.imageId,
    name: input.name,
    memory: input.memory,
    web: input.web,
  };
  const description = input.description?.trim();
  if (description) {body.description = description;}
  if (input.web) {
    body.subdomain = input.subdomain?.trim() || "random";
    if (input.port !== undefined) {body.port = input.port;}
  }
  if (input.envs.length > 0) {body.envs = input.envs.map(({ key, value }) => ({ key, value }));}
  if (input.workspaceId) {body.workspace_id = input.workspaceId;}
  return body;
}
