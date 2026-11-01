import type { APIPlansCatalog } from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

let cached: Promise<APIPlansCatalog> | undefined;

/** Catálogo público de planos (`GET /v1/plans`), em cache de memória pela sessão; falha não fica em cache. */
export function getPlansCatalog(client: ApiClient): Promise<APIPlansCatalog> {
  if (!cached) {
    const pending = client.request<APIPlansCatalog>("/v1/plans", { anonymous: true });
    cached = pending;
    pending.catch(() => {
      if (cached === pending) {cached = undefined;}
    });
  }
  return cached;
}

export function resetPlansCache(): void {
  cached = undefined;
}
