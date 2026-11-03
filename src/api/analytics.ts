import type {
  APIApplicationAnalyticsErrors,
  APIApplicationAnalyticsPerformance,
  APIApplicationAnalyticsRequestList,
  APIApplicationAnalyticsTraffic,
  ISODateString,
} from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

/** Janela de leitura: sem `start`/`end` a API usa as últimas 24 h. */
export interface AnalyticsWindow {
  start?: ISODateString;
  end?: ISODateString;
}

export function getAnalytics(client: ApiClient, appId: string, window: AnalyticsWindow): Promise<APIApplicationAnalyticsTraffic> {
  return client.request<APIApplicationAnalyticsTraffic>(`/v1/apps/${appId}/analytics`, { query: { ...window, compare: true } });
}

export function getAnalyticsErrors(client: ApiClient, appId: string, window: AnalyticsWindow): Promise<APIApplicationAnalyticsErrors> {
  return client.request<APIApplicationAnalyticsErrors>(`/v1/apps/${appId}/analytics/errors`, { query: { ...window, compare: true } });
}

export function getAnalyticsPerformance(client: ApiClient, appId: string, window: AnalyticsWindow): Promise<APIApplicationAnalyticsPerformance> {
  return client.request<APIApplicationAnalyticsPerformance>(`/v1/apps/${appId}/analytics/performance`, { query: { ...window, compare: true } });
}

/** Uma página do log de requisições (50, da mais nova à mais velha). `cursor` e `window` iguais aos da página anterior. */
export function listAnalyticsRequests(
  client: ApiClient,
  appId: string,
  window: Required<AnalyticsWindow>,
  cursor?: string,
): Promise<APIApplicationAnalyticsRequestList> {
  return client.request<APIApplicationAnalyticsRequestList>(`/v1/apps/${appId}/analytics/requests`, {
    query: { ...window, cursor, order: "desc", limit: 50 },
  });
}
