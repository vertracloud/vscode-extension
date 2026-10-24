import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { APIUserInfoResponse } from "@vertracloud/api-types/v1";

/**
 * Planos que criam imagem própria (`max_custom_images > 0`). O payload do usuário não traz a flag: a lista é a
 * mesma que o texto da view de imagens anuncia para o estado vazio (Enterprise 28, 30 e 32).
 */
const PLANS_WITH_IMAGES = new Set(["enterprise-28", "enterprise-30", "enterprise-32"]);

/** `false` sem plano ou sem o usuário carregado: sem o sinal, nada é oferecido. */
export function planAllowsImages(user: Pick<APIUserInfoResponse, "plan"> | undefined): boolean {
  const name = user?.plan?.name;
  return typeof name === "string" && PLANS_WITH_IMAGES.has(name);
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
