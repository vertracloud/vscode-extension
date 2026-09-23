import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseSse, type SseEvent } from "../src/sse";

async function run(chunks: Array<string | Uint8Array>): Promise<SseEvent[]> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  const events: SseEvent[] = [];
  const reader = stream.pipeThrough(parseSse()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {break;}
    events.push(value);
  }
  return events;
}

describe("parseSse", () => {
  it("lê um frame inteiro", async () => {
    const events = await run(["event: logs\ndata: hello\n\n"]);
    assert.deepEqual(events, [{ event: "logs", data: "hello" }]);
  });

  it("tolera frame partido em três chunks no meio de data:", async () => {
    const events = await run(["event: logs\nda", "ta: hel", "lo\n\n"]);
    assert.deepEqual(events, [{ event: "logs", data: "hello" }]);
  });

  it("tolera caractere multibyte partido entre chunks", async () => {
    const bytes = new TextEncoder().encode("event: logs\ndata: ação\n\n");
    const cut = bytes.indexOf(0xc3);
    const events = await run([bytes.slice(0, cut + 1), bytes.slice(cut + 1)]);
    assert.deepEqual(events, [{ event: "logs", data: "ação" }]);
  });

  it("ignora linha de comentário", async () => {
    const events = await run([": ping\nevent: logs\ndata: a\n\n"]);
    assert.deepEqual(events, [{ event: "logs", data: "a" }]);
  });

  it("concatena dois data: com quebra de linha", async () => {
    const events = await run(["event: logs\ndata: um\ndata: dois\n\n"]);
    assert.deepEqual(events, [{ event: "logs", data: "um\ndois" }]);
  });

  it("aceita \\r\\n e \\r", async () => {
    const events = await run(["event: logs\r\ndata: a\r\n\r\n", "event: logs\rdata: b\r\r"]);
    assert.deepEqual(events, [
      { event: "logs", data: "a" },
      { event: "logs", data: "b" },
    ]);
  });

  it("aceita \\r\\n partido entre chunks", async () => {
    const events = await run(["event: logs\r", "\ndata: a\r\n\r\n"]);
    assert.deepEqual(events, [{ event: "logs", data: "a" }]);
  });

  it("usa message quando não há nome de evento, e lê id", async () => {
    const events = await run(["id: 7\ndata: a\n\n"]);
    assert.deepEqual(events, [{ event: "message", data: "a", id: "7" }]);
  });

  it("descarta frame incompleto no flush", async () => {
    const events = await run(["event: logs\ndata: a\n\nevent: logs\ndata: b\n"]);
    assert.deepEqual(events, [{ event: "logs", data: "a" }]);
  });
});
