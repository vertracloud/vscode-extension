import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import * as vscode from "vscode";
import { createGetBlob } from "../src/blob/client";

const ws = vscode.workspace as unknown as { getConfiguration?: unknown };
const original = ws.getConfiguration;

function withBaseUrl(value: string | undefined) {
  ws.getConfiguration = () => ({ get: () => value });
}

afterEach(() => {
  ws.getConfiguration = original;
});

describe("blob base URL guard", () => {
  const session = { getToken: async () => "tok" };

  it("accepts the default and Vertra hosts", async () => {
    for (const url of [
      undefined,
      "https://blob.vertracloud.app/v1",
      "https://eu.vertracloud.app/v1",
    ]) {
      withBaseUrl(url);
      await createGetBlob(session)();
    }
  });

  it("refuses foreign, lookalike, http and credentialed URLs before building a client", async () => {
    for (const url of [
      "https://evil.example/v1",
      "https://vertracloud.app.evil.example/v1",
      "https://evilvertracloud.app/v1",
      "http://blob.vertracloud.app/v1",
      "https://user:pw@blob.vertracloud.app/v1",
      "not a url",
    ]) {
      withBaseUrl(url);
      await assert.rejects(createGetBlob(session)(), { code: "BLOB_BASE_URL_UNTRUSTED" });
    }
  });
});
