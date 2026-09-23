import type { APIApplicationDeployment } from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

export function getAppDeploys(client: ApiClient, appId: string): Promise<APIApplicationDeployment[]> {
  return client.request<APIApplicationDeployment[]>(`/v1/apps/${appId}/deploys`);
}

/**
 * `GET .../deploys/webhook`: o `.d.ts` declara só `{url}`, mas a rota devolve também
 * `repo_owner`/`repo_name` (drift real, ver API_MATRIX §A.6). Validado em runtime — nunca
 * confiar só no tipo declarado.
 */
export interface WebhookRepoInfo {
  url: string;
  repoOwner?: string;
  repoName?: string;
}

export async function getDeployWebhook(client: ApiClient, appId: string): Promise<WebhookRepoInfo> {
  const raw = await client.request<{ webhook_url?: string; url?: string; repo_owner?: string; repo_name?: string }>(
    `/v1/apps/${appId}/deploys/webhook`,
  );
  return {
    url: raw.webhook_url ?? raw.url ?? "",
    repoOwner: raw.repo_owner,
    repoName: raw.repo_name,
  };
}
