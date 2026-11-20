import * as vscode from "vscode";

const DEFAULT_BASE_URL = "https://api.vertracloud.app";
const DEFAULT_TIMEOUT_MS = 30_000;
/** Criar um snapshot e abrir o download podem passar de 95 s. */
export const DESTRUCTIVE_TIMEOUT_MS = 10 * 60_000;
/** Download não tem prazo total: só estoura quando ficam tantos ms sem chegar byte (o relógio reinicia a cada pedaço). */
export const DOWNLOAD_INACTIVITY_MS = 60_000;
const RETRY_DELAY_MS = 500;
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const UNAUTHORIZED_CODES = new Set(["API_KEY_INVALID", "SESSION_REVOKED", "AUTH_TOKEN_MISSING"]);

/** Resolvido uma vez: em build de dev o esbuild substitui a expressão por literal. */
export const baseUrl = process.env.VERTRA_API_URL || DEFAULT_BASE_URL;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfter?: number;

  constructor(status: number, code: string, message?: string, details?: unknown, retryAfter?: number) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: number;
  quotaRemaining?: number;
  quotaReset?: number;
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  form?: FormData;
  timeoutMs?: number;
  token?: vscode.CancellationToken;
  retryIdempotent?: boolean;
  raw?: boolean;
  /** Só com `raw`: ms sem receber byte antes de desistir (padrão 60 s). `timeoutMs` passa a valer só até os cabeçalhos chegarem. */
  inactivityMs?: number;
  /**
   * Só com `raw`: cada pedaço do corpo vai para cá assim que chega, em vez de ficar na memória (o resultado é `undefined`).
   * Sem nova tentativa: depois de um byte escrito não dá para repetir o pedido. Um erro do `sink` sobe como está.
   */
  sink?: (chunk: Uint8Array) => Promise<void>;
  /** Sem `Authorization`, mesmo com token disponível. */
  anonymous?: boolean;
  accept?: string;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  // Todo path é relativo à base da API: URL absoluta levaria o Bearer a outra origem.
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new ApiError(0, "INVALID_PATH", "API path must be relative to the API base URL");
  }
  const url = new URL(baseUrl + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {url.searchParams.set(key, String(value));}
    }
  }
  return url.toString();
}

function numberOrUndefined(value: string | null): number | undefined {
  if (value === null) {return undefined;}
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readRetryAfter(details: unknown, headers: Headers): number | undefined {
  if (details && typeof details === "object" && "retry_after" in details) {
    const value = (details as { retry_after?: unknown }).retry_after;
    if (typeof value === "number" && Number.isFinite(value)) {return value;}
  }
  return numberOrUndefined(headers.get("retry-after"));
}

export class ApiClient {
  readonly userAgent: string;
  lastRateLimit: RateLimitInfo = {};

  private readonly getToken: () => Promise<string | undefined>;
  private readonly unauthorized = new vscode.EventEmitter<ApiError>();
  readonly onUnauthorized = this.unauthorized.event;

  constructor(getToken: () => Promise<string | undefined>, userAgent: string) {
    this.getToken = getToken;
    this.userAgent = userAgent;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const canRetry = method === "GET" ? opts.retryIdempotent !== false && !opts.sink : false;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt<T>(path, method, opts);
      } catch (error) {
        const retryable =
          error instanceof ApiError &&
          (RETRYABLE_STATUS.has(error.status) || error.code === "NETWORK_ERROR");
        if (canRetry && attempt === 0 && retryable) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }
        throw error;
      }
    }
  }

  async stream(
    path: string,
    opts: { query?: Record<string, QueryValue>; signal: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>> {
    const url = buildUrl(path, opts.query);
    const headers = await this.headers({ accept: "text/event-stream" });
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        redirect: "error",
        signal: opts.signal,
      });
    } catch (error) {
      throw this.networkError(error, opts.signal.aborted, false);
    }
    this.captureRateLimit(response.headers);
    if (!response.ok) {throw await this.errorFromResponse(response);}
    if (!response.body) {throw new ApiError(response.status, "NETWORK_ERROR", "Empty stream body");}
    return response.body as ReadableStream<Uint8Array>;
  }

  private async attempt<T>(path: string, method: string, opts: RequestOptions): Promise<T> {
    const url = buildUrl(path, opts.query);
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const subscription = opts.token?.onCancellationRequested(() => {
      cancelled = true;
      controller.abort();
    });
    if (opts.token?.isCancellationRequested) {
      cancelled = true;
      controller.abort();
    }

    try {
      const headers = await this.headers({
        accept: opts.accept ?? "application/json",
        anonymous: opts.anonymous,
      });

      let body: BodyInit | undefined;
      if (opts.form) {
        body = opts.form;
      } else if (opts.body instanceof URLSearchParams) {
        body = opts.body;
      } else if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body,
          // Nunca seguir redirect: o fetch reenviaria o Bearer a outra origem.
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        throw this.networkError(error, cancelled, timedOut);
      }

      this.captureRateLimit(response.headers);
      if (!response.ok) {throw await this.errorFromResponse(response, opts.anonymous);}
      if (opts.raw) {
        // Sem prazo total: o corpo de um download grande pode levar minutos, desde que continue chegando.
        clearTimeout(timer);
        return (await this.readBody(response, controller, opts.inactivityMs ?? DOWNLOAD_INACTIVITY_MS, () => cancelled, opts.sink)) as T;
      }

      const text = await response.text();
      if (!text) {return undefined as T;}
      try {
        const json = JSON.parse(text) as { response?: unknown };
        return (json && json.response !== undefined ? json.response : json) as T;
      } catch {
        throw new ApiError(response.status, `HTTP_${response.status}`, response.statusText);
      }
    } finally {
      clearTimeout(timer);
      subscription?.dispose();
    }
  }

  private networkError(error: unknown, cancelled: boolean, timedOut: boolean): ApiError {
    if (cancelled) {return new ApiError(0, "CANCELLED", "Request cancelled");}
    if (timedOut) {return new ApiError(0, "TIMEOUT", "Request timed out");}
    const name = error instanceof Error ? error.name : undefined;
    if (name === "TimeoutError") {return new ApiError(0, "TIMEOUT", "Request timed out");}
    if (name === "AbortError") {return new ApiError(0, "CANCELLED", "Request cancelled");}
    return new ApiError(0, "NETWORK_ERROR", error instanceof Error ? error.message : String(error));
  }

  private async headers(opts: { accept: string; anonymous?: boolean }): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: opts.accept,
      "User-Agent": this.userAgent,
    };
    if (!opts.anonymous) {
      const token = await this.getToken();
      if (token) {headers.Authorization = `Bearer ${token}`;}
    }
    return headers;
  }

  private captureRateLimit(headers: Headers): void {
    const info: RateLimitInfo = {
      limit: numberOrUndefined(headers.get("x-ratelimit-limit")),
      remaining: numberOrUndefined(headers.get("x-ratelimit-remaining")),
      reset: numberOrUndefined(headers.get("x-ratelimit-reset")),
      quotaRemaining: numberOrUndefined(headers.get("x-quota-remaining")),
      quotaReset: numberOrUndefined(headers.get("x-quota-reset")),
    };
    if (Object.values(info).some((value) => value !== undefined)) {this.lastRateLimit = info;}
  }

  private async readBody(
    response: Response,
    controller: AbortController,
    inactivityMs: number,
    wasCancelled: () => boolean,
    sink?: (chunk: Uint8Array) => Promise<void>,
  ): Promise<ArrayBuffer | undefined> {
    if (!response.body) {return sink ? undefined : new ArrayBuffer(0);}
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let stalled = false;
    let sinkFailure: { error: unknown } | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, inactivityMs);
    };
    arm();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {break;}
        if (sink) {
          // O disco lento não conta como download parado: o relógio só corre enquanto se espera a rede.
          clearTimeout(idle);
          try {
            await sink(value);
          } catch (error) {
            sinkFailure = { error };
            throw error;
          }
        } else {
          chunks.push(value);
        }
        total += value.byteLength;
        arm();
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      if (sinkFailure) {throw sinkFailure.error;}
      if (stalled) {throw new ApiError(0, "TIMEOUT", "No data received from the server");}
      throw this.networkError(error, wasCancelled(), false);
    } finally {
      clearTimeout(idle);
    }
    if (sink) {return undefined;}
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }

  private async errorFromResponse(response: Response, anonymous?: boolean): Promise<ApiError> {
    const text = await response.text().catch(() => "");
    let payload: { code?: unknown; message?: unknown; details?: unknown } = {};
    try {
      payload = text ? (JSON.parse(text) as typeof payload) : {};
    } catch {
      payload = {};
    }
    const code = typeof payload.code === "string" ? payload.code : `HTTP_${response.status}`;
    const message = typeof payload.message === "string" ? payload.message : response.statusText || code;
    const error = new ApiError(
      response.status,
      code,
      message,
      payload.details,
      readRetryAfter(payload.details, response.headers),
    );
    if (!anonymous && response.status === 401 && UNAUTHORIZED_CODES.has(code)) {this.unauthorized.fire(error);}
    return error;
  }
}
