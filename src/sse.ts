export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

interface Frame {
  event?: string;
  data: string[];
  id?: string;
}

function emptyFrame(): Frame {
  return { data: [] };
}

function dispatch(frame: Frame, controller: TransformStreamDefaultController<SseEvent>): void {
  if (frame.data.length === 0) {return;}
  const event: SseEvent = { event: frame.event || "message", data: frame.data.join("\n") };
  if (frame.id !== undefined) {event.id = frame.id;}
  controller.enqueue(event);
}

function applyField(frame: Frame, line: string): void {
  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) {value = value.slice(1);}
  if (field === "event") {frame.event = value;}
  else if (field === "data") {frame.data.push(value);}
  else if (field === "id" && !value.includes("\0")) {frame.id = value;}
}

/** Parser SSE incremental: tolera frame partido entre chunks e caractere multibyte cortado. */
export function parseSse(): TransformStream<Uint8Array, SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let frame = emptyFrame();

  const drain = (controller: TransformStreamDefaultController<SseEvent>, final: boolean) => {
    for (;;) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (!match) {break;}
      // Um "\r" no fim do buffer pode ser a primeira metade de um "\r\n" partido entre chunks.
      if (!final && match[0] === "\r" && match.index + 1 === buffer.length) {break;}
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === "") {
        dispatch(frame, controller);
        frame = emptyFrame();
      } else if (!line.startsWith(":")) {
        applyField(frame, line);
      }
    }
  };

  return new TransformStream<Uint8Array, SseEvent>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(controller, false);
    },
    flush(controller) {
      buffer += decoder.decode();
      drain(controller, true);
      // Frame sem linha em branco final está incompleto: descartado.
      buffer = "";
      frame = emptyFrame();
    },
  });
}
