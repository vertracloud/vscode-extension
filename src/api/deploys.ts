import type { APIApplicationDeployment, APIApplicationWebhook } from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

export function getAppDeploys(client: ApiClient, appId: string): Promise<APIApplicationDeployment[]> {
  return client.request<APIApplicationDeployment[]>(`/v1/apps/${appId}/deploys`);
}

/**
 * `GET .../deploys/webhook`. Os campos vêm de `APIApplicationWebhook`; `url` continua aceito como
 * fallback de `webhook_url` e tudo é validado em runtime, nunca confiando só no tipo declarado.
 * `branch` é `null` no vínculo criado sem branch (reage a push em `main` ou `master`).
 */
export interface WebhookRepoInfo {
  url: string;
  repoOwner?: string;
  repoName?: string;
  branch?: string | null;
}

export async function getDeployWebhook(client: ApiClient, appId: string): Promise<WebhookRepoInfo> {
  const raw = await client.request<Partial<APIApplicationWebhook> & { url?: string }>(
    `/v1/apps/${appId}/deploys/webhook`,
  );
  return {
    url: raw.webhook_url ?? raw.url ?? "",
    repoOwner: raw.repo_owner,
    repoName: raw.repo_name,
    branch: raw.branch,
  };
}
