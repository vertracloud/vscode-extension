import type { APIApplicationFileTree, APIApplicationFile, APIApplicationFileContent } from "@vertracloud/api-types/v1";
import { ApiError } from "./client";
import type { ApiClient } from "./client";

export interface RemoteFileContent {
  bytes: Uint8Array;
  /** Tamanho real em bytes; `size` da listagem vem formatado ("1.20 KB") e não serve. */
  size: number;
  lastModified?: string;
}

interface Scoped {
  workspaceId?: string;
}

const scope = (opts?: Scoped) => ({ workspace_id: opts?.workspaceId });

export function listFiles(
  client: ApiClient,
  appId: string,
  path: string,
  opts?: Scoped,
): Promise<APIApplicationFile[]> {
  return client.request<APIApplicationFile[]>(`/v1/apps/${appId}/files`, {
    query: { path, ...scope(opts) },
  });
}

export function listTree(client: ApiClient, appId: string, opts?: Scoped): Promise<APIApplicationFileTree> {
  return client.request<APIApplicationFileTree>(`/v1/apps/${appId}/files/tree`, { query: { ...scope(opts) } });
}

export async function readFile(
  client: ApiClient,
  appId: string,
  path: string,
  opts?: Scoped,
): Promise<RemoteFileContent> {
  const payload = await client.request<APIApplicationFileContent>(
    `/v1/apps/${appId}/files/content`,
    { query: { path, ...scope(opts) } },
  );
  const bytes = new Uint8Array(Buffer.from(payload.data, "base64"));
  return { bytes, size: payload.size, lastModified: payload.last_modified };
}

/**
 * `content` vai como texto UTF-8, não base64: o servidor grava a string do corpo direto no arquivo.
 * Arquivo binário não sobrevive a esse caminho — a leitura é que é base64.
 */
export function writeFile(
  client: ApiClient,
  appId: string,
  path: string,
  content: Uint8Array,
  lastModified?: string,
  opts?: Scoped,
): Promise<unknown> {
  return client.request(`/v1/apps/${appId}/files`, {
    method: "PUT",
    query: { path, ...scope(opts) },
    body: { content: decodeUtf8Text(content), last_modified: lastModified },
  });
}

/**
 * Conteúdo que não é texto UTF-8 seria gravado corrompido (byte inválido vira U+FFFD, NUL trunca
 * do lado do volume): recusar é a única saída que não destrói o arquivo do usuário.
 */
function decodeUtf8Text(content: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new ApiError(0, "FILE_NOT_TEXT", "File is not valid UTF-8 text");
  }
  if (text.includes("\u0000")) {
    throw new ApiError(0, "FILE_NOT_TEXT", "File is not valid UTF-8 text");
  }
  return text;
}

/** Pasta é sinalizada pela barra no fim do caminho e pela ausência de `content`. */
export function createDirectory(
  client: ApiClient,
  appId: string,
  path: string,
  opts?: Scoped,
): Promise<unknown> {
  return client.request(`/v1/apps/${appId}/files`, {
    method: "PUT",
    query: { path: `${path}/`, ...scope(opts) },
    body: {},
  });
}

export function moveFile(
  client: ApiClient,
  appId: string,
  path: string,
  to: string,
  opts?: Scoped,
): Promise<unknown> {
  return client.request(`/v1/apps/${appId}/files`, {
    method: "PATCH",
    query: { path, to, ...scope(opts) },
    body: {},
  });
}

export function deleteFile(
  client: ApiClient,
  appId: string,
  path: string,
  opts?: Scoped,
): Promise<unknown> {
  return client.request(`/v1/apps/${appId}/files`, {
    method: "DELETE",
    query: { path, ...scope(opts) },
  });
}
