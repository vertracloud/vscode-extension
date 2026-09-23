import * as vscode from "vscode";

const DEFAULT_BASE_URL = "https://api.vertracloud.app";
const DEFAULT_TIMEOUT_MS = 30_000;
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
  /** Sem `Authorization`, mesmo com token disponível. */
  anonymous?: boolean;
  accept?: string;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path.startsWith("http") ? path : baseUrl + path);
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
    const canRetry = method === "GET" ? opts.retryIdempotent !== false : false;

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
    const headers = await this.headers({ accept: "text/event-stream" });
    let response: Response;
    try {
      response = await fetch(buildUrl(path, opts.query), { headers, signal: opts.signal });
    } catch (error) {
      throw this.networkError(error, opts.signal.aborted, false);
    }
    this.captureRateLimit(response.headers);
    if (!response.ok) {throw await this.errorFromResponse(response);}
    if (!response.body) {throw new ApiError(response.status, "NETWORK_ERROR", "Empty stream body");}
    return response.body as ReadableStream<Uint8Array>;
  }

  private async attempt<T>(path: string, method: string, opts: RequestOptions): Promise<T> {
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
        response = await fetch(buildUrl(path, opts.query), {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (error) {
        throw this.networkError(error, cancelled, timedOut);
      }

      this.captureRateLimit(response.headers);
      if (!response.ok) {throw await this.errorFromResponse(response, opts.anonymous);}
      if (opts.raw) {return (await response.arrayBuffer()) as T;}

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
