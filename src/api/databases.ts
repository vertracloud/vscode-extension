import type {
  APIDatabase,
  APIDatabaseMetrics,
  APIDatabasePasswordReset,
  RESTPostAPIDatabaseCreateBody,
} from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

export type MetricsRange = "10m" | "30m" | "24h";

interface Scoped {
  workspaceId?: string;
}

const scope = (opts?: Scoped) => ({ workspace_id: opts?.workspaceId });

export function createDatabase(
  client: ApiClient,
  body: RESTPostAPIDatabaseCreateBody,
): Promise<APIDatabase> {
  return client.request<APIDatabase>("/v1/databases", { method: "POST", body });
}

export function updateDatabase(
  client: ApiClient,
  id: string,
  body: { name?: string; description?: string; ram?: number },
  opts?: Scoped,
): Promise<APIDatabase> {
  return client.request<APIDatabase>(`/v1/databases/${id}`, {
    method: "PUT",
    body,
    query: scope(opts),
  });
}

export function deleteDatabase(client: ApiClient, id: string, opts?: Scoped): Promise<unknown> {
  return client.request<unknown>(`/v1/databases/${id}`, { method: "DELETE", query: scope(opts) });
}

export function startDatabase(client: ApiClient, id: string, opts?: Scoped): Promise<boolean> {
  return client.request<boolean>(`/v1/databases/${id}/start`, { method: "POST", query: scope(opts) });
}

export function stopDatabase(client: ApiClient, id: string, opts?: Scoped): Promise<boolean> {
  return client.request<boolean>(`/v1/databases/${id}/stop`, { method: "POST", query: scope(opts) });
}

export function getDatabaseMetrics(
  client: ApiClient,
  id: string,
  range: MetricsRange,
  opts?: Scoped,
): Promise<APIDatabaseMetrics[]> {
  return client.request<APIDatabaseMetrics[]>(`/v1/databases/${id}/metrics`, {
    query: { range, ...scope(opts) },
  });
}

export function downloadDatabaseCertificate(
  client: ApiClient,
  id: string,
  opts?: Scoped,
): Promise<ArrayBuffer> {
  return client.request<ArrayBuffer>(`/v1/databases/${id}/credentials/certificate`, {
    query: scope(opts),
    raw: true,
  });
}

export function resetDatabasePassword(
  client: ApiClient,
  id: string,
  opts?: Scoped,
): Promise<APIDatabasePasswordReset> {
  return client.request<APIDatabasePasswordReset>(`/v1/databases/${id}/credentials/reset`, {
    method: "POST",
    query: scope(opts),
  });
}
