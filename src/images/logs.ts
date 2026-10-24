import { parseSse } from "../sse";

// OutputChannel não renderiza escape ANSI: sem remover, a saída colorida do build chega suja.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export type ImageLogEnd = "ended" | "idle" | "cancelled" | "interrupted";

export interface ReadImageLogOptions {
  /** O mesmo controller com que o stream foi aberto: abortar encerra a leitura. */
  controller: AbortController;
  onLine(line: string): void;
  /**
   * Sem build rodando o servidor repete o histórico e pode ficar aberto: encerra depois desse tempo
   * sem linha nova (como a CLI). Ausente = segue até o stream acabar.
   */
  idleMs?: number;
}

/** Lê o stream SSE do log do build: cada evento `log` (ou sem nome) traz uma linha. */
export async function readImageLog(body: ReadableStream<Uint8Array>, opts: ReadImageLogOptions): Promise<ImageLogEnd> {
  const { controller } = opts;
  let idleFired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (opts.idleMs === undefined) {return;}
    if (timer) {clearTimeout(timer);}
    timer = setTimeout(() => {
      idleFired = true;
      controller.abort();
    }, opts.idleMs);
  };

  arm();
  const reader = body.pipeThrough(parseSse()).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {return "ended";}
      if (value.event !== "log" && value.event !== "message") {continue;}
      arm();
      opts.onLine(value.data.replace(ANSI, ""));
    }
  } catch {
    if (idleFired) {return "idle";}
    return controller.signal.aborted ? "cancelled" : "interrupted";
  } finally {
    if (timer) {clearTimeout(timer);}
    reader.releaseLock?.();
  }
}
