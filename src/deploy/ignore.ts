import ignore, { type Ignore } from "ignore";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * `.env` fica de fora do default: o app hospedado precisa dele (a plataforma não tem
 * variáveis de ambiente fora do zip na criação/commit), diferente do `.gitignore` de um repo
 * comum. Nada no contrato da API remove `.env` do lado do servidor.
 */
export const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ".gitignore",
  ".vscode",
  ".github",
  ".vertraignore",
  ".vertracloudignore",
  "__pycache__",
  "venv",
  ".venv",
  "vendor",
  "target",
  ".next",
  ".DS_Store",
  "*.vsix",
];

const IGNORE_FILES = [".vertraignore", ".vertracloudignore"];

async function readFirstExisting(root: string): Promise<string | undefined> {
  for (const name of IGNORE_FILES) {
    try {
      return await fs.readFile(path.join(root, name), "utf8");
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Semântica gitignore via `ignore`, com os defaults da plataforma e, se existir, o primeiro
 * de `.vertraignore`/`.vertracloudignore` (não mescla os dois). `.gitignore` nunca é lido como
 * regra — só existe na lista de defaults para não zipar o próprio arquivo.
 */
export async function loadIgnore(root: string): Promise<Ignore> {
  const ig = ignore().add(DEFAULT_IGNORE);
  const userRules = await readFirstExisting(root);
  if (userRules) {ig.add(userRules);}
  return ig;
}

export function isIgnored(ig: Ignore, relPosixPath: string, isDir: boolean): boolean {
  return ig.ignores(isDir ? `${relPosixPath}/` : relPosixPath);
}
