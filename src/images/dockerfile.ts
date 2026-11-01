import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { APIPlansCatalog, APIUserInfoResponse } from "@vertracloud/api-types/v1";

/**
 * O plano da conta cria imagem própria quando `limits.max_custom_images > 0` no catálogo de `GET /v1/plans`.
 * `false` sem plano ou sem o usuário carregado. Se a rota falha ou não conhece o plano, `true`: quem decide é a api,
 * que responde `PLAN_DOES_NOT_SUPPORT_CUSTOM_IMAGES`.
 */
export async function planAllowsImages(
  user: Pick<APIUserInfoResponse, "plan"> | undefined,
  loadCatalog: () => Promise<APIPlansCatalog>,
): Promise<boolean> {
  const name = user?.plan?.name;
  if (typeof name !== "string") {return false;}
  try {
    const plan = (await loadCatalog()).plans.find((p) => p.name === name);
    return plan ? plan.limits.max_custom_images > 0 : true;
  } catch {
    return true;
  }
}

async function hasDockerfile(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // Nome exato: em sistemas que ignoram caixa, só a listagem mostra a grafia real.
    return entries.some((entry) => entry.name === "Dockerfile" && entry.isFile());
  } catch {
    return false;
  }
}

/**
 * Pasta que tem o `Dockerfile` na raiz: a própria pasta ou, como o `/new` do website trata um zip, a única pasta
 * dentro dela. `undefined` quando não há.
 */
export async function findDockerfileRoot(folder: string): Promise<string | undefined> {
  if (await hasDockerfile(folder)) {return folder;}
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return undefined;
  }
  if (entries.length !== 1 || !entries[0].isDirectory()) {return undefined;}
  const inner = path.join(folder, entries[0].name);
  return (await hasDockerfile(inner)) ? inner : undefined;
}
