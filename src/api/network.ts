import type {
  APIApplicationWebPublish,
  RESTDeleteAPIApplicationDomainResponse,
  RESTGetAPIApplicationDomainDnsResponse,
  RESTGetAPIApplicationDomainsResponse,
  RESTPatchAPIApplicationDomainBody,
  RESTPatchAPIApplicationDomainResponse,
  RESTPostAPIApplicationDomainBody,
  RESTPostAPIApplicationDomainResponse,
  RESTPostAPIApplicationPurgeCacheBody,
  RESTPostAPIApplicationWebPublishBody,
} from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

type Success<T> = Extract<T, { response: unknown }>["response"];

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

export function listAppDomains(client: ApiClient, appId: string): Promise<Success<RESTGetAPIApplicationDomainsResponse>> {
  return client.request<Success<RESTGetAPIApplicationDomainsResponse>>(`/v1/apps/${appId}/domains`);
}

export function addAppDomain(
  client: ApiClient,
  appId: string,
  body: RESTPostAPIApplicationDomainBody,
): Promise<Success<RESTPostAPIApplicationDomainResponse>> {
  return client.request<Success<RESTPostAPIApplicationDomainResponse>>(`/v1/apps/${appId}/domains`, {
    method: "POST",
    body,
  });
}

export function updateAppDomain(
  client: ApiClient,
  appId: string,
  domainId: string,
  body: RESTPatchAPIApplicationDomainBody,
): Promise<Success<RESTPatchAPIApplicationDomainResponse>> {
  return client.request<Success<RESTPatchAPIApplicationDomainResponse>>(`/v1/apps/${appId}/domains/${domainId}`, {
    method: "PATCH",
    body,
  });
}

export function removeAppDomain(
  client: ApiClient,
  appId: string,
  domainId: string,
): Promise<Success<RESTDeleteAPIApplicationDomainResponse>> {
  return client.request<Success<RESTDeleteAPIApplicationDomainResponse>>(`/v1/apps/${appId}/domains/${domainId}`, {
    method: "DELETE",
  });
}

export function getAppDomainDns(
  client: ApiClient,
  appId: string,
  domainId: string,
): Promise<Success<RESTGetAPIApplicationDomainDnsResponse>> {
  return client.request<Success<RESTGetAPIApplicationDomainDnsResponse>>(`/v1/apps/${appId}/domains/${domainId}/dns`);
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
