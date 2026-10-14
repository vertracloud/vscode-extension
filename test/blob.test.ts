import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as vscode from "vscode";
import type { BlobApi } from "../src/blob/client";
import { describeBlobError } from "../src/blob/errors";
import { BlobFileSystemProvider } from "../src/blob/fs";
import { BlobDropController, normalizePrefix, parseUriList, registerBlob } from "../src/blob/commands";
import { collectEntries } from "../src/blob/upload";
import { BlobProvider, type BlobNode } from "../src/views/blob";
import type { CommandDeps } from "../src/commands/deps";
import { createFakeExtensionContext, env, registeredCommands } from "./vscode-mock";

type Obj = {
  id: string;
  path: string;
  size: number;
  content_type: string;
  visibility: "public" | "private";
  url: string | null;
  created_at: string;
  updated_at: string;
};

function obj(path: string, visibility: "public" | "private" = "public", content_type = "image/png"): Obj {
  return {
    id: `id-${path}`,
    path,
    size: 2048,
    content_type,
    visibility,
    url: visibility === "public" ? `https://cdn.example/${path}` : null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
  };
}

interface Fake {
  api: BlobApi;
  calls: Array<[string, ...unknown[]]>;
}

function fakeBlob(overrides: Record<string, unknown> = {}): Fake {
  const calls: Fake["calls"] = [];
  const api = {
    stats: async () => ({ used_bytes: 1024, quota_bytes: 1024 * 1024 * 1024 }),
    listPage: async (opts: { prefix?: string; cursor?: string }) => {
      calls.push(["listPage", opts]);
      if (opts.prefix === "images/") {return { objects: [obj("images/logo.png")], folders: [], cursor: null };}
      if (!opts.cursor) {return { objects: [obj("a.txt", "private", "text/plain")], folders: ["images/"], cursor: "next" };}
      return { objects: [obj("b.txt", "private", "text/plain")], folders: [], cursor: null };
    },
    get: async (id: string) => obj(id.replace("id-", "")),
    update: async (...args: unknown[]) => (calls.push(["update", ...args]), obj("x")),
    move: async (...args: unknown[]) => (calls.push(["move", ...args]), obj("x")),
    delete: async (...args: unknown[]) => void calls.push(["delete", ...args]),
    deleteMany: async (...args: unknown[]) => (calls.push(["deleteMany", ...args]), { deleted: [], not_found: [], remaining: false }),
    downloadUrl: async (...args: unknown[]) => (calls.push(["downloadUrl", ...args]), { url: "https://signed.example/f", expires_at: "x" }),
    put: async (...args: unknown[]) => (calls.push(["put", ...args]), obj("x")),
    ...overrides,
  } as unknown as BlobApi;
  return { api, calls };
}

const win = vscode.window as unknown as Record<string, unknown>;
const saved = { ...win };
let shown: string[] = [];

beforeEach(() => {
  shown = [];
  registeredCommands.clear();
  win.showErrorMessage = async (m: string) => void shown.push(`error:${m}`);
  win.showInformationMessage = async (m: string) => void shown.push(`info:${m}`);
  win.showWarningMessage = async (m: string) => (shown.push(`warn:${m}`), "Delete");
});
afterEach(() => Object.assign(win, saved));

function setup(fake: Fake): { provider: BlobProvider; errors: unknown[] } {
  const errors: unknown[] = [];
  const deps = {
    context: createFakeExtensionContext(),
    session: { onDidChange: () => ({ dispose() {} }), getToken: async () => "tok" },
    showError: (e: unknown) => void errors.push(e),
  } as unknown as CommandDeps;
  const { provider } = registerBlob(deps, async () => fake.api);
  return { provider, errors };
}

const run = (id: string, ...args: unknown[]) => registeredCommands.get(id)!(...args);
const objectNode = (o: Obj): BlobNode => ({ kind: "object", object: o as never });

describe("blob tree", () => {
  it("root lists usage, folders first, then objects, across pages", async () => {
    const provider = new BlobProvider(async () => fakeBlob().api);
    const children = await provider.getChildren();
    assert.deepEqual(children.map((c) => c.kind), ["stats", "folder", "object", "object"]);
    const stats = provider.getTreeItem(children[0]);
    assert.equal(stats.description, "1.0 KB of 1.0 GB");
    assert.equal(provider.getTreeItem(children[1]).label, "images");
  });

  it("folder children use the prefix and delimiter, without a usage row", async () => {
    const fake = fakeBlob();
    const provider = new BlobProvider(async () => fake.api);
    const children = await provider.getChildren({ kind: "folder", prefix: "images/" });
    assert.deepEqual(children.map((c) => c.kind), ["object"]);
    assert.deepEqual(fake.calls[0][1], { prefix: "images/", delimiter: "/", limit: 1000, cursor: undefined });
  });

  it("marks visibility in contextValue and description", () => {
    const provider = new BlobProvider(async () => fakeBlob().api);
    assert.equal(provider.getTreeItem(objectNode(obj("a.png"))).contextValue, "blob:object:public");
    const priv = provider.getTreeItem(objectNode(obj("a.txt", "private", "text/plain")));
    assert.equal(priv.contextValue, "blob:object:private");
    assert.match(String(priv.description), /private/);
  });

  it("a failed load becomes a message, not a throw", async () => {
    const messages: Array<string | undefined> = [];
    const provider = new BlobProvider(async () => {
      throw Object.assign(new Error("x"), { code: "STORAGE_QUOTA_EXCEEDED" });
    });
    provider.onMessage = (m) => messages.push(m);
    assert.deepEqual(await provider.getChildren(), []);
    assert.match(messages[0] ?? "", /storage is full/);
  });
});

describe("blob error mapping", () => {
  it("maps blob codes to fixed sentences and never echoes the raw message", () => {
    const text = describeBlobError({ code: "BLOB_OBJECT_ALREADY_EXISTS", message: "internal detail" });
    assert.equal(text, "A file already exists at this path.");
    assert.ok(!text.includes("internal"));
  });

  it("falls back to the shared catalog for other codes", () => {
    assert.match(describeBlobError({ code: "API_KEY_SCOPE_DENIED", details: { required: "blob:write" } }), /blob:write/);
  });

  it("scope errors go to the shared handler (Open API keys action); blob errors are shown directly", async () => {
    const fake = fakeBlob({
      delete: async () => {
        throw Object.assign(new Error("x"), { code: "API_KEY_SCOPE_DENIED" });
      },
      downloadUrl: async () => {
        throw Object.assign(new Error("x"), { code: "BLOB_OBJECT_NOT_FOUND" });
      },
    });
    const { errors } = setup(fake);
    await run("vertraCloud.blob.delete", objectNode(obj("a.png")));
    assert.equal((errors[0] as { code: string }).code, "API_KEY_SCOPE_DENIED");
    await run("vertraCloud.blob.tempLink", objectNode(obj("a.png")));
    assert.equal(errors.length, 1);
  });
});

describe("blob commands", () => {
  it("copies the public URL and the Markdown image link", async () => {
    setup(fakeBlob());
    await run("vertraCloud.blob.copyUrl", objectNode(obj("img/a.png")));
    assert.equal(env.clipboard.text, "https://cdn.example/img/a.png");
    await run("vertraCloud.blob.copyMarkdown", objectNode(obj("img/a.png")));
    assert.equal(env.clipboard.text, "![a.png](https://cdn.example/img/a.png)");
  });

  it("temporary link asks for the validity and copies the signed URL", async () => {
    const fake = fakeBlob();
    setup(fake);
    win.showQuickPick = async (items: Array<{ seconds: number }>) => items[1];
    await run("vertraCloud.blob.tempLink", objectNode(obj("a.png")));
    assert.deepEqual(fake.calls[0], ["downloadUrl", "id-a.png", { expiresIn: 3600 }]);
    assert.equal(env.clipboard.text, "https://signed.example/f");
  });

  it("delete needs confirmation", async () => {
    const fake = fakeBlob();
    setup(fake);
    win.showWarningMessage = async () => undefined;
    await run("vertraCloud.blob.delete", objectNode(obj("a.png")));
    assert.equal(fake.calls.length, 0);
    win.showWarningMessage = async () => "Delete";
    await run("vertraCloud.blob.delete", objectNode(obj("a.png")));
    await run("vertraCloud.blob.delete", { kind: "folder", prefix: "tmp/" });
    assert.deepEqual(fake.calls, [["delete", "id-a.png"], ["deleteMany", { prefix: "tmp/" }]]);
  });

  it("toggle visibility: private to public confirms, public to private does not", async () => {
    const fake = fakeBlob();
    setup(fake);
    win.showWarningMessage = async () => undefined;
    await run("vertraCloud.blob.toggleVisibility", objectNode(obj("a.txt", "private")));
    assert.equal(fake.calls.length, 0);
    await run("vertraCloud.blob.toggleVisibility", objectNode(obj("a.png", "public")));
    assert.deepEqual(fake.calls[0], ["update", "id-a.png", { visibility: "private" }]);
  });

  it("rename moves the object to the new path", async () => {
    const fake = fakeBlob();
    setup(fake);
    win.showInputBox = async () => "img/new.png";
    await run("vertraCloud.blob.rename", objectNode(obj("a.png")));
    assert.deepEqual(fake.calls[0], ["move", "id-a.png", "img/new.png"]);
  });

  it("preview opens images and text through the vertra-blob scheme", async () => {
    setup(fakeBlob());
    const { executedCommands } = await import("./vscode-mock");
    executedCommands.length = 0;
    await run("vertraCloud.blob.preview", objectNode(obj("a.png")));
    const opened = executedCommands.find((c) => c.command === "vscode.open")?.args[0] as vscode.Uri;
    assert.equal(opened.scheme, "vertra-blob");
    assert.equal(opened.authority, "id-a.png");
  });
});

describe("blob upload", () => {
  function tree(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "blob-test-"));
    mkdirSync(path.join(dir, "site", "css"), { recursive: true });
    writeFileSync(path.join(dir, "site", "index.html"), "<h1>hi</h1>");
    writeFileSync(path.join(dir, "site", "css", "a.css"), "a{}");
    writeFileSync(path.join(dir, "solo.txt"), "x");
    return dir;
  }

  it("expands folders keeping the folder name as the first segment", async () => {
    const dir = tree();
    const entries = await collectEntries([vscode.Uri.file(path.join(dir, "site")), vscode.Uri.file(path.join(dir, "solo.txt"))]);
    assert.deepEqual(entries.map((e) => e.rel).sort(), ["site/css/a.css", "site/index.html", "solo.txt"]);
  });

  it("the Explorer command uploads under the chosen folder; existing paths are skipped", async () => {
    const dir = tree();
    const fake = fakeBlob({
      put: async (p: string, _data: unknown, opts: { signal: AbortSignal }) => {
        fake.calls.push(["put", p, opts.signal instanceof AbortSignal]);
        if (p.endsWith("solo.txt")) {throw Object.assign(new Error("x"), { code: "BLOB_OBJECT_ALREADY_EXISTS" });}
        return obj(p);
      },
    });
    setup(fake);
    win.showInputBox = async () => "/assets/";
    const solo = vscode.Uri.file(path.join(dir, "solo.txt"));
    const site = vscode.Uri.file(path.join(dir, "site"));
    await run("vertraCloud.blob.upload", solo, [solo, site]);
    const puts = fake.calls.filter((c) => c[0] === "put").map((c) => c[1]).sort();
    assert.deepEqual(puts, ["assets/site/css/a.css", "assets/site/index.html", "assets/solo.txt"]);
    assert.ok(shown.some((m) => m.startsWith("info:2 uploaded, 1 skipped")));
  });

  it("dropping on an object uploads next to it; on empty space uploads to the root", async () => {
    const got: Array<[number, string]> = [];
    const controller = new BlobDropController(async (uris, prefix) => void got.push([uris.length, prefix]));
    const data = (text: string) => ({ get: () => ({ asString: async () => text }) }) as unknown as vscode.DataTransfer;
    await controller.handleDrop(objectNode(obj("img/a.png")), data("file:///tmp/x.png\r\n# comment"));
    await controller.handleDrop(undefined, data("file:///tmp/x.png"));
    await controller.handleDrop({ kind: "folder", prefix: "docs/" }, data("file:///tmp/x.png"));
    assert.deepEqual(got, [[1, "img/"], [1, ""], [1, "docs/"]]);
  });

  it("helpers", () => {
    assert.equal(normalizePrefix(" /a/b// "), "a/b/");
    assert.equal(normalizePrefix(""), "");
    assert.equal(parseUriList("").length, 0);
  });
});

describe("vertra-blob file system", () => {
  it("is read-only and reads bytes through a signed URL", async () => {
    const fake = fakeBlob();
    const seen: string[] = [];
    const provider = new BlobFileSystemProvider(async () => fake.api, (async (url: string) => {
      seen.push(url);
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch);
    const uri = vscode.Uri.from({ scheme: "vertra-blob", authority: "id-a.png", path: "/a.png" });
    assert.deepEqual([...(await provider.readFile(uri))], [1, 2, 3]);
    assert.deepEqual(seen, ["https://signed.example/f"]);
    assert.equal((await provider.stat(uri)).size, 2048);
    assert.throws(() => provider.writeFile(uri), { code: "NoPermissions" });
  });
});
