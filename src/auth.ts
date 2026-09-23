import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { APIUserInfoResponse } from "@vertracloud/api-types/v1";
import * as vscode from "vscode";
import { ApiClient, ApiError, baseUrl } from "./api/client";
import { getMe } from "./api/endpoints";

const SECRET_KEY = "vertraCloudApiKey";
const CLIENT_NAME = "Vertra Cloud for VS Code";
const OAUTH_TIMEOUT_MS = 5 * 60_000;
const SCOPES = [
  "account:read",
  "apps:read",
  "apps:write",
  "apps:envs",
  "apps:files",
  "apps:delete",
  "databases:read",
  "databases:write",
  "databases:delete",
  "databases:credentials",
  "snapshots:read",
  "snapshots:write",
  "workspaces:read",
  "workspaces:write",
].join(" ");

export type SessionState =
  | { status: "disconnected"; reason?: "network" }
  | { status: "connecting" }
  | { status: "connected"; user: APIUserInfoResponse };

interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function randomSecret(): string {
  return base64url(crypto.randomBytes(32));
}

function challengeOf(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isTransient(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT");
}

function assertSameOrigin(discovery: DiscoveryDocument): void {
  const expected = new URL(baseUrl).origin;
  for (const endpoint of [
    discovery.registration_endpoint,
    discovery.authorization_endpoint,
    discovery.token_endpoint,
  ]) {
    if (new URL(endpoint).origin !== expected) {
      throw new ApiError(0, "OAUTH_INVALID_DISCOVERY", vscode.l10n.t("The authorization server metadata is invalid."));
    }
  }
}

export class Session {
  private readonly secrets: vscode.SecretStorage;
  private readonly client: ApiClient;
  private readonly emitter = new vscode.EventEmitter<SessionState>();
  private cachedToken?: string;
  private tokenLoaded = false;
  private current: SessionState = { status: "disconnected" };

  readonly onDidChange = this.emitter.event;

  constructor(secrets: vscode.SecretStorage, client: ApiClient) {
    this.secrets = secrets;
    this.client = client;
    client.onUnauthorized(() => {
      void this.disconnect();
    });
  }

  get state(): SessionState {
    return this.current;
  }

  async getToken(): Promise<string | undefined> {
    if (!this.tokenLoaded) {
      this.cachedToken = await this.secrets.get(SECRET_KEY);
      this.tokenLoaded = true;
    }
    return this.cachedToken;
  }

  async restore(): Promise<void> {
    const token = await this.getToken();
    if (!token) {
      this.setState({ status: "disconnected" });
      return;
    }
    this.setState({ status: "connecting" });
    try {
      const user = await getMe(this.client);
      this.setState({ status: "connected", user });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await this.clearToken();
        this.setState({ status: "disconnected" });
        return;
      }
      this.setState(isTransient(error) ? { status: "disconnected", reason: "network" } : { status: "disconnected" });
    }
  }

  async connectWithApiKey(key: string): Promise<void> {
    const previous = this.current;
    this.setState({ status: "connecting" });
    try {
      const user = await this.validate(key);
      await this.storeToken(key);
      this.setState({ status: "connected", user });
    } catch (error) {
      this.setState(previous);
      throw error;
    }
  }

  async connectWithOAuth(token?: vscode.CancellationToken): Promise<void> {
    const previous = this.current;
    this.setState({ status: "connecting" });
    let verifier = randomSecret();
    let state = randomSecret();
    const server = http.createServer();
    let timer: NodeJS.Timeout | undefined;

    try {
      const discovery = await this.client.request<DiscoveryDocument>(
        "/.well-known/oauth-authorization-server",
        { anonymous: true, token },
      );
      assertSameOrigin(discovery);

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = (server.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      const registration = await this.client
        .request<{ client_id?: string }>(discovery.registration_endpoint, {
          method: "POST",
          anonymous: true,
          token,
          body: { client_name: CLIENT_NAME, redirect_uris: [redirectUri] },
        })
        .catch((error: unknown) => {
          throw new ApiError(
            error instanceof ApiError ? error.status : 0,
            "OAUTH_REGISTRATION_FAILED",
            error instanceof Error ? error.message : undefined,
          );
        });
      const clientId = registration.client_id;
      if (!clientId) {
        throw new ApiError(0, "OAUTH_REGISTRATION_FAILED", "Missing client_id");
      }

      const code = await this.waitForCode(server, {
        state,
        onListening: async () => {
          const url = new URL(discovery.authorization_endpoint);
          url.searchParams.set("client_id", clientId);
          url.searchParams.set("redirect_uri", redirectUri);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("scope", SCOPES);
          url.searchParams.set("code_challenge", challengeOf(verifier));
          url.searchParams.set("code_challenge_method", "S256");
          url.searchParams.set("state", state);
          await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
        },
        cancellation: token,
        setTimer: (handle) => {
          timer = handle;
        },
      });

      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      });
      const tokenResponse = await this.client
        .request<{ access_token?: string }>(discovery.token_endpoint, {
          method: "POST",
          anonymous: true,
          body: form,
        })
        .catch((error: unknown) => {
          throw new ApiError(
            error instanceof ApiError ? error.status : 0,
            "OAUTH_TOKEN_FAILED",
            error instanceof Error ? error.message : undefined,
          );
        });
      if (!tokenResponse.access_token) {
        throw new ApiError(0, "OAUTH_TOKEN_FAILED", "Missing access_token");
      }

      const user = await this.validate(tokenResponse.access_token);
      await this.storeToken(tokenResponse.access_token);
      this.setState({ status: "connected", user });
    } catch (error) {
      this.setState(previous);
      throw error;
    } finally {
      verifier = "";
      state = "";
      if (timer) {clearTimeout(timer);}
      if (server.listening) {
        server.closeAllConnections?.();
        server.close();
      }
    }
  }

  async disconnect(): Promise<void> {
    await this.clearToken();
    this.setState({ status: "disconnected" });
  }

  private waitForCode(
    server: http.Server,
    opts: {
      state: string;
      onListening: () => Promise<void>;
      cancellation?: vscode.CancellationToken;
      setTimer: (handle: NodeJS.Timeout) => void;
    },
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      opts.setTimer(
        setTimeout(() => reject(new ApiError(0, "OAUTH_TIMEOUT", "Authorization timed out")), OAUTH_TIMEOUT_MS),
      );
      const cancelSub = opts.cancellation?.onCancellationRequested(() =>
        reject(new ApiError(0, "CANCELLED", "Authorization cancelled")),
      );
      if (opts.cancellation?.isCancellationRequested) {
        reject(new ApiError(0, "CANCELLED", "Authorization cancelled"));
      }

      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Vertra Cloud</title><body><p>${vscode.l10n.t(
            "You can close this window.",
          )}</p></body>`,
        );
        cancelSub?.dispose();

        if (!sameSecret(url.searchParams.get("state") ?? "", opts.state)) {
          reject(new ApiError(0, "OAUTH_STATE_MISMATCH", "Authorization state mismatch"));
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        if (error || !code) {
          reject(new ApiError(0, "OAUTH_DENIED", error ?? "Authorization denied"));
          return;
        }
        resolve(code);
      });

      opts.onListening().catch(reject);
    });
  }

  private async validate(key: string): Promise<APIUserInfoResponse> {
    const probe = new ApiClient(async () => key, this.client.userAgent);
    return getMe(probe);
  }

  private async storeToken(key: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, key);
    this.cachedToken = key;
    this.tokenLoaded = true;
  }

  private async clearToken(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    this.cachedToken = undefined;
    this.tokenLoaded = true;
  }

  private setState(state: SessionState): void {
    this.current = state;
    this.emitter.fire(state);
  }
}
