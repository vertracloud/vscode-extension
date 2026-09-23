import type {
  APIApplicationMetric,
  APIApplicationOperationResponse,
  APIApplicationStatusShort,
  APIDatabase,
  APIDatabaseStatusShort,
  APIStatus,
  APIUserInfoResponse,
  APIWorkspace,
  APIWorkspaceInfoResponse,
  RESTPostAPIApplicationRestartBody,
} from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

export type MetricsRange = "10m" | "30m" | "24h";

interface Scoped {
  workspaceId?: string;
}

const scope = (opts?: Scoped) => ({ workspace_id: opts?.workspaceId });

export function getMe(client: ApiClient): Promise<APIUserInfoResponse> {
  return client.request<APIUserInfoResponse>("/v1/users/me");
}

export function getServiceStatus(client: ApiClient): Promise<APIStatus> {
  return client.request<APIStatus>("/v1/status", { anonymous: true });
}

export function getAppsStatus(client: ApiClient, opts?: Scoped): Promise<APIApplicationStatusShort[]> {
  return client.request<APIApplicationStatusShort[]>("/v1/apps/status", { query: scope(opts) });
}

export function startApp(
  client: ApiClient,
  id: string,
  opts?: Scoped,
): Promise<APIApplicationOperationResponse> {
  return client.request<APIApplicationOperationResponse>(`/v1/apps/${id}/start`, {
    method: "POST",
    query: scope(opts),
  });
}

export function stopApp(
  client: ApiClient,
  id: string,
  opts?: Scoped,
): Promise<APIApplicationOperationResponse> {
  return client.request<APIApplicationOperationResponse>(`/v1/apps/${id}/stop`, {
    method: "POST",
    query: scope(opts),
  });
}

export function restartApp(
  client: ApiClient,
  id: string,
  body?: RESTPostAPIApplicationRestartBody,
  opts?: Scoped,
): Promise<APIApplicationOperationResponse> {
  return client.request<APIApplicationOperationResponse>(`/v1/apps/${id}/restart`, {
    method: "POST",
    body,
    query: scope(opts),
  });
}

export function getAppLogs(client: ApiClient, id: string, opts?: Scoped): Promise<string> {
  return client.request<string>(`/v1/apps/${id}/logs`, { query: scope(opts) });
}

export function getAppMetrics(
  client: ApiClient,
  id: string,
  range: MetricsRange,
  opts?: Scoped,
): Promise<APIApplicationMetric[]> {
  return client.request<APIApplicationMetric[]>(`/v1/apps/${id}/metrics`, {
    query: { range, ...scope(opts) },
  });
}

export function getDatabasesStatus(client: ApiClient, opts?: Scoped): Promise<APIDatabaseStatusShort[]> {
  return client.request<APIDatabaseStatusShort[]>("/v1/databases/status", { query: scope(opts) });
}

export function getDatabase(client: ApiClient, id: string, opts?: Scoped): Promise<APIDatabase> {
  return client.request<APIDatabase>(`/v1/databases/${id}`, { query: scope(opts) });
}

export function getWorkspaces(client: ApiClient): Promise<APIWorkspace[]> {
  return client.request<APIWorkspace[]>("/v1/workspaces");
}

export function getWorkspace(client: ApiClient, workspaceId: string): Promise<APIWorkspaceInfoResponse> {
  return client.request<APIWorkspaceInfoResponse>(`/v1/workspaces/${encodeURIComponent(workspaceId)}`);
}

export function deleteApp(client: ApiClient, id: string, opts?: Scoped): Promise<unknown> {
  return client.request<unknown>(`/v1/apps/${id}`, { method: "DELETE", query: scope(opts) });
}

interface RuntimeEntry {
  recommended?: string;
  latest?: string;
  specific?: string[];
}

/** `GET /v1/apps/runtimes` devolve um mapa linguagem → versões; a extensão só usa os nomes de versão. */
export async function getRuntimes(client: ApiClient): Promise<string[]> {
  const raw = await client.request<Record<string, RuntimeEntry>>("/v1/apps/runtimes");
  const versions = new Set<string>();
  for (const entry of Object.values(raw ?? {})) {
    if (typeof entry?.recommended === "string") {versions.add(entry.recommended);}
    if (typeof entry?.latest === "string") {versions.add(entry.latest);}
    for (const version of entry?.specific ?? []) {
      if (typeof version === "string") {versions.add(version);}
    }
  }
  return [...versions];
}
