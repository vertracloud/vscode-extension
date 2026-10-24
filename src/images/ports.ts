import type * as vscode from "vscode";

const KEY = "vertraCloud.images.suggestedPorts";
const DEFAULT_PORT = 80;

/** Porta de 1 a 65535 digitada pelo usuário; `undefined` quando não é válida. */
export function parsePort(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {return undefined;}
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Porta pré-preenchida ao criar ou publicar um app de imagem: a que o app já tem, senão o `suggested_port`
 * da API (primeiro `EXPOSE` do último build), senão a guardada da checagem do Dockerfile, senão 80.
 */
export function chooseImagePort(opts: { current?: number | null; api?: number | null; hint?: number }): number {
  for (const candidate of [opts.current, opts.api, opts.hint]) {
    if (candidate && candidate >= 1 && candidate <= 65535) {return candidate;}
  }
  return DEFAULT_PORT;
}

/** Guarda por imagem o `suggested_port` da última checagem: a API de imagem não devolve o Dockerfile. */
export class PortHints {
  constructor(private readonly memento: vscode.Memento) {}

  get(imageId: string): number | undefined {
    const stored = this.memento.get<Record<string, number>>(KEY, {});
    const port = stored[imageId];
    return typeof port === "number" ? port : undefined;
  }

  async set(imageId: string, port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {return;}
    const stored = { ...this.memento.get<Record<string, number>>(KEY, {}), [imageId]: port };
    await this.memento.update(KEY, stored);
  }
}
