import type { APIUserInfoResponse } from "@vertracloud/api-types/v1";
import * as vscode from "vscode";
import { ApiClient, ApiError } from "./api/client";
import { getMe } from "./api/endpoints";

const SECRET_KEY = "vertraCloudApiKey";

export type SessionState =
  | { status: "disconnected"; reason?: "network" }
  | { status: "connecting" }
  | { status: "connected"; user: APIUserInfoResponse };

function isTransient(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT");
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

  async disconnect(): Promise<void> {
    await this.clearToken();
    this.setState({ status: "disconnected" });
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
