import type {
  APIApplicationEnvironment,
  RESTPostAPIApplicationEnvironmentVariableBody,
} from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

export function getAppEnvs(client: ApiClient, appId: string): Promise<APIApplicationEnvironment[]> {
  return client.request<APIApplicationEnvironment[]>(`/v1/apps/${appId}/envs`);
}

export function upsertAppEnv(
  client: ApiClient,
  appId: string,
  body: RESTPostAPIApplicationEnvironmentVariableBody,
): Promise<APIApplicationEnvironment[]> {
  return client.request<APIApplicationEnvironment[]>(`/v1/apps/${appId}/envs`, {
    method: "POST",
    body,
  });
}

export function deleteAppEnv(client: ApiClient, appId: string, envId: string): Promise<void> {
  return client.request<void>(`/v1/apps/${appId}/envs/${envId}`, { method: "DELETE" });
}
