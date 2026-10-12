import type {
  APIApplicationRelease,
  APIApplicationReleaseLog,
  APIApplicationRollbackPreview,
  PaginationMeta,
  RESTPostAPIApplicationRollbackBody,
} from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

/** Versões do código do app, da mais nova para a mais velha (o máximo da API é 50 por página). */
export function listReleases(client: ApiClient, appId: string, page = 1): Promise<PaginationMeta<APIApplicationRelease>> {
  return client.request<PaginationMeta<APIApplicationRelease>>(`/v1/apps/${appId}/releases`, { query: { page, limit: 50 } });
}

export function getReleaseLog(client: ApiClient, appId: string, releaseId: string): Promise<APIApplicationReleaseLog> {
  return client.request<APIApplicationReleaseLog>(`/v1/apps/${appId}/releases/${releaseId}/log`);
}

/** O que voltar para a versão mudaria nas variáveis: só nomes, nunca valores. Não muda nada. */
export function previewRollback(client: ApiClient, appId: string, releaseId: string): Promise<APIApplicationRollbackPreview> {
  return client.request<APIApplicationRollbackPreview>(`/v1/apps/${appId}/releases/${releaseId}/rollback`);
}

export function rollbackRelease(
  client: ApiClient,
  appId: string,
  releaseId: string,
  body: RESTPostAPIApplicationRollbackBody,
): Promise<APIApplicationRelease> {
  return client.request<APIApplicationRelease>(`/v1/apps/${appId}/releases/${releaseId}/rollback`, {
    method: "POST",
    body,
    timeoutMs: 10 * 60_000,
  });
}
