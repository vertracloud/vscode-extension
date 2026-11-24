export function readUnlessAborted<T>(reader: ReadableStreamDefaultReader<T>, signal: AbortSignal): Promise<ReadableStreamReadResult<T>> {
  return new Promise((resolve, reject) => {
    const fail = (): void => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) {return fail();}
    signal.addEventListener("abort", fail, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", fail);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", fail);
        reject(error);
      },
    );
  });
}
