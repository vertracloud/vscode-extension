import type {
  APIApplicationWebPublish,
  APIApplicationDnsRecord,
  RESTPostAPIApplicationPurgeCacheBody,
  RESTPostAPIApplicationWebPublishBody,
} from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

export function publishApp(
  client: ApiClient,
  appId: string,
  body: RESTPostAPIApplicationWebPublishBody,
): Promise<APIApplicationWebPublish> {
  return client.request<APIApplicationWebPublish>(`/v1/apps/${appId}/network/publish`, {
    method: "POST",
    body,
  });
}

export function unpublishApp(client: ApiClient, appId: string): Promise<APIApplicationWebPublish> {
  return client.request<APIApplicationWebPublish>(`/v1/apps/${appId}/network/publish`, { method: "DELETE" });
}

export function setAppSubdomain(client: ApiClient, appId: string, subdomain: string): Promise<{ subdomain: string }> {
  return client.request<{ subdomain: string }>(`/v1/apps/${appId}/network/subdomain`, {
    method: "PATCH",
    body: { subdomain },
  });
}

export function getAppDnsRecords(client: ApiClient, appId: string): Promise<APIApplicationDnsRecord[]> {
  return client.request<APIApplicationDnsRecord[]>(`/v1/apps/${appId}/network/dns`);
}

/**
 * Corpo `APIApplicationCustomDomain` (`{ domain }`) de `@vertracloud/api-types`.
 * 404 `NO_CUSTOM_DOMAIN` é o caminho normal de "sem domínio próprio" — o chamador trata.
 */
export function getAppCustomDomain(client: ApiClient, appId: string): Promise<{ domain?: string }> {
  return client.request<{ domain?: string }>(`/v1/apps/${appId}/network/custom`);
}

export function addAppCustomDomain(client: ApiClient, appId: string, domain: string): Promise<unknown> {
  return client.request<unknown>(`/v1/apps/${appId}/network/custom`, {
    method: "POST",
    body: { domain },
  });
}

export function removeAppCustomDomain(client: ApiClient, appId: string): Promise<unknown> {
  return client.request<unknown>(`/v1/apps/${appId}/network/custom`, { method: "DELETE" });
}

export function purgeAppCache(
  client: ApiClient,
  appId: string,
  body: RESTPostAPIApplicationPurgeCacheBody = {},
): Promise<unknown> {
  return client.request<unknown>(`/v1/apps/${appId}/network/purge-cache`, {
    method: "POST",
    body,
  });
}
