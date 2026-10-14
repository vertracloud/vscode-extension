import * as vscode from "vscode";
import { BlobClient } from "@vertracloud/blob";
import type { Session } from "../auth";

export const DEFAULT_BLOB_URL = "https://blob.vertracloud.app/v1";

/** The slice of the SDK the extension uses; tests pass a fake. */
export type BlobApi = Pick<
  BlobClient,
  "listPage" | "stats" | "get" | "update" | "move" | "delete" | "deleteMany" | "downloadUrl" | "put"
>;

export type GetBlob = () => Promise<BlobApi>;

/** The bearer is attached to this URL, so it must be https and a Vertra host; anything else never gets a request. */
export function assertTrustedBlobUrl(raw: string): string {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    // falls through to the refusal
  }
  const host = url?.hostname.toLowerCase() ?? "";
  const ok =
    url?.protocol === "https:" &&
    !url.username &&
    !url.password &&
    host.endsWith(".vertracloud.app");
  if (!ok) {
    throw Object.assign(new Error("blob base URL is not a Vertra host"), { code: "BLOB_BASE_URL_UNTRUSTED" });
  }
  return raw;
}

function configuredBaseUrl(): string {
  const value = vscode.workspace.getConfiguration?.("vertraCloud").get<string>("blob.baseUrl");
  return assertTrustedBlobUrl(value?.trim() || DEFAULT_BLOB_URL);
}

/** Same bearer the rest of the extension uses; rebuilt only when the token or the base URL changes. */
export function createGetBlob(session: Pick<Session, "getToken">): GetBlob {
  let cached: { key: string; client: BlobClient } | undefined;
  return async () => {
    const token = await session.getToken();
    if (!token) {
      throw Object.assign(new Error("not connected"), { code: "API_KEY_INVALID", status: 401 });
    }
    const baseUrl = configuredBaseUrl();
    const key = `${baseUrl}\n${token}`;
    if (cached?.key !== key) {cached = { key, client: new BlobClient({ apiKey: token, baseUrl }) };}
    return cached.client;
  };
}
