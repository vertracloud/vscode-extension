import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";

/**
 * Corre `run` dando-lhe um `sink` que grava cada pedaço num arquivo temporário ao lado de `dest` (modo 0600), e só no fim, com tudo
 * gravado, dá o nome final por `rename`. Erro, cancelamento ou queda do disco apagam o temporário: o nome final nunca guarda
 * arquivo pela metade, e um `dest` que já existia só é trocado no fim. Memória: um pedaço. Devolve os bytes gravados.
 */
export async function writeThroughTempFile(
  dest: string,
  run: (sink: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<number> {
  const temp = `${dest}.${randomBytes(6).toString("hex")}.part`;
  const handle = await fs.open(temp, "wx", 0o600);
  let written = 0;
  try {
    await run(async (chunk) => {
      await handle.write(chunk);
      written += chunk.byteLength;
    });
    await handle.close();
    await fs.rename(temp, dest);
    return written;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true });
    throw error;
  }
}
