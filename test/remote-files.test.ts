import assert from "node:assert/strict";
import { beforeEach, describe, it } from "vitest";
import type { ApiClient } from "../src/api/client";
import { VertraFileSystemProvider, remoteUri } from "../src/remote-files";
import { FileType } from "./vscode-mock";
import { registerFilesCommands } from "../src/commands/files";
import type { CommandDeps } from "../src/commands/deps";
import {
  addedWorkspaceFolders,
  createFakeExtensionContext,
  executedCommands,
  registeredCommands,
  workspace,
} from "./vscode-mock";

interface Call {
  path: string;
  method: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

interface Fake {
  client: ApiClient;
  calls: Call[];
  reply: (call: Call) => unknown;
}

function fakeClient(reply: (call: Call) => unknown): Fake {
  const calls: Call[] = [];
  const client = {
    request: async (path: string, opts: { method?: string; query?: Record<string, unknown>; body?: unknown } = {}) => {
      const call: Call = { path, method: opts.method ?? "GET", query: opts.query, body: opts.body };
      calls.push(call);
      const result = reply(call);
      if (result instanceof Error) {throw result;}
      return result;
    },
  } as unknown as ApiClient;
  return { client, calls, reply };
}

function apiError(code: string, status = 400): Error & { code: string; status: number } {
  return Object.assign(new Error(code), { code, status });
}

const dirEntry = (name: string, type: "file" | "directory") => ({
  name,
  path: `/${name}`,
  type,
  last_modified: "2026-09-01T12:00:00.000Z",
});

beforeEach(() => {
  workspace.isTrusted = true;
  workspace.workspaceFolders = undefined;
  addedWorkspaceFolders.length = 0;
  executedCommands.length = 0;
  registeredCommands.clear();
});

describe("VertraFileSystemProvider", () => {
  it("decodifica conteúdo base64 sem corromper bytes", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    const { client } = fakeClient(() => ({
      type: "base64",
      data: Buffer.from(bytes).toString("base64"),
      size: bytes.length,
      last_modified: "2026-09-01T12:00:00.000Z",
    }));
    const provider = new VertraFileSystemProvider(client);

    const read = await provider.readFile(remoteUri("app-1", "bin.dat"));
    assert.deepEqual([...read], [...bytes]);
  });

  it("manda o last_modified conhecido ao gravar por cima", async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.path.endsWith("/files/content")) {
        return {
          type: "base64",
          data: Buffer.from("old").toString("base64"),
          size: 3,
          last_modified: "2026-09-01T12:00:00.000Z",
        };
      }
      if (call.method === "GET") {return [dirEntry("a.txt", "file")];}
      return undefined;
    });
    const provider = new VertraFileSystemProvider(client);
    const uri = remoteUri("app-1", "a.txt");

    await provider.readFile(uri);
    await provider.writeFile(uri, Buffer.from("new"), { create: true, overwrite: true });

    const put = calls.find((call) => call.method === "PUT");
    assert.equal(put?.query?.path, "a.txt");
    assert.deepEqual(put?.body, { content: "new", last_modified: "2026-09-01T12:00:00.000Z" });
  });

  it("FILE_MODIFIED vira erro de sistema de arquivos", async () => {
    const { client } = fakeClient((call) => {
      if (call.method === "GET") {return [dirEntry("a.txt", "file")];}
      return apiError("FILE_MODIFIED", 409);
    });
    const provider = new VertraFileSystemProvider(client);

    await assert.rejects(
      provider.writeFile(remoteUri("app-1", "a.txt"), Buffer.from("x"), { create: true, overwrite: true }),
      (err: Error) => err.name === "FileSystemError" && /reload/i.test(err.message),
    );
  });

  it("recusa gravar conteúdo que não é texto UTF-8", async () => {
    const { client, calls } = fakeClient((call) =>
      call.method === "GET" ? [dirEntry("bin.dat", "file")] : undefined,
    );
    const provider = new VertraFileSystemProvider(client);
    await assert.rejects(
      provider.writeFile(remoteUri("app-1", "bin.dat"), new Uint8Array([0xff, 0xfe, 0x00]), {
        create: true,
        overwrite: true,
      }),
      (err: Error) => /UTF-8/.test(err.message),
    );
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  });

  it("recusa gravar texto com NUL", async () => {
    const { client, calls } = fakeClient((call) =>
      call.method === "GET" ? [dirEntry("bin.dat", "file")] : undefined,
    );
    const provider = new VertraFileSystemProvider(client);
    await assert.rejects(
      provider.writeFile(remoteUri("app-1", "bin.dat"), new TextEncoder().encode("a\u0000b"), {
        create: true,
        overwrite: true,
      }),
      (err: Error) => /UTF-8/.test(err.message),
    );
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  });

  it("PLAN_RESTRICTED_FEATURE vira NoPermissions", async () => {
    const { client } = fakeClient(() => apiError("PLAN_RESTRICTED_FEATURE", 403));
    const provider = new VertraFileSystemProvider(client);

    await assert.rejects(provider.readDirectory(remoteUri("app-1")), (err: Error & { code?: string }) => err.code === "NoPermissions");
  });

  it("recusa caminho com .. sem tocar na API", async () => {
    const { client, calls } = fakeClient(() => []);
    const provider = new VertraFileSystemProvider(client);

    await assert.rejects(provider.readFile(remoteUri("app-1", "../secret")), (err: Error & { code?: string }) => err.code === "FileNotFound");
    assert.equal(calls.length, 0);
  });

  it("workspace não confiável bloqueia escrita sem chamar a API", async () => {
    workspace.isTrusted = false;
    const { client, calls } = fakeClient(() => []);
    const provider = new VertraFileSystemProvider(client);

    await assert.rejects(
      provider.writeFile(remoteUri("app-1", "a.txt"), Buffer.from("x"), { create: true, overwrite: true }),
      (err: Error & { code?: string }) => err.code === "NoPermissions",
    );
    await assert.rejects(provider.delete(remoteUri("app-1", "a.txt"), { recursive: true }));
    await assert.rejects(provider.rename(remoteUri("app-1", "a.txt"), remoteUri("app-1", "b.txt"), { overwrite: true }));
    assert.equal(calls.length, 0);
  });

  it("cacheia a listagem do diretório entre stats seguidos", async () => {
    const { client, calls } = fakeClient(() => [dirEntry("a.txt", "file"), dirEntry("src", "directory")]);
    const provider = new VertraFileSystemProvider(client);

    await provider.readDirectory(remoteUri("app-1"));
    await provider.stat(remoteUri("app-1", "a.txt"));
    await provider.stat(remoteUri("app-1", "src"));

    assert.equal(calls.filter((call) => call.path.endsWith("/files")).length, 1);
    assert.equal(calls.filter((call) => call.path.endsWith("/files/tree")).length, 1);
  });

  it("rename e delete batem nas rotas certas", async () => {
    const { client, calls } = fakeClient((call) => (call.method === "GET" ? [dirEntry("a.txt", "file")] : undefined));
    const provider = new VertraFileSystemProvider(client);

    await provider.rename(remoteUri("app-1", "a.txt"), remoteUri("app-1", "b.txt"), { overwrite: true });
    await provider.delete(remoteUri("app-1", "a.txt"), { recursive: true });

    const patch = calls.find((call) => call.method === "PATCH");
    assert.equal(patch?.path, "/v1/apps/app-1/files");
    assert.deepEqual([patch?.query?.path, patch?.query?.to], ["a.txt", "b.txt"]);

    const del = calls.find((call) => call.method === "DELETE");
    assert.equal(del?.path, "/v1/apps/app-1/files");
    assert.equal(del?.query?.path, "a.txt");
  });

  it("apagar pasta sem recursive é recusado", async () => {
    const { client } = fakeClient(() => [dirEntry("src", "directory")]);
    const provider = new VertraFileSystemProvider(client);

    await assert.rejects(
      provider.delete(remoteUri("app-1", "src"), { recursive: false }),
      (err: Error & { code?: string }) => err.code === "NoPermissions",
    );
  });
});

describe("vertraCloud.app.openRemoteFiles", () => {
  function makeDeps(client: ApiClient): CommandDeps {
    const context = createFakeExtensionContext();
    return {
      context,
      client,
      resolveApp: async () => ({ app: { id: "app-1", name: "My App" }, favorite: false }),
      showError: () => {},
    } as unknown as CommandDeps;
  }

  it("adiciona a pasta uma vez e só revela na segunda chamada", async () => {
    const { client } = fakeClient(() => []);
    registerFilesCommands(makeDeps(client));
    const run = registeredCommands.get("vertraCloud.app.openRemoteFiles")!;

    await run(undefined);
    await run(undefined);

    assert.equal(addedWorkspaceFolders.length, 1);
    assert.equal(addedWorkspaceFolders[0].name, "My App (Vertra)");
    assert.equal(addedWorkspaceFolders[0].uri.toString(), "vertra://app-1/");
    assert.ok(executedCommands.some((call) => call.command === "revealInExplorer"));
  });

  it("não monta a pasta quando o plano não inclui o recurso", async () => {
    const { client } = fakeClient(() => apiError("PLAN_RESTRICTED_FEATURE", 403));
    registerFilesCommands(makeDeps(client));

    await registeredCommands.get("vertraCloud.app.openRemoteFiles")!(undefined);

    assert.equal(addedWorkspaceFolders.length, 0);
  });

  it("uma árvore por app alimenta todas as pastas e stats concorrentes compartilham a requisição", async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.path.endsWith("/files/tree")) {
        return {
          type: "directory", name: "", path: "", last_modified: "2026-09-01T12:00:00.000Z",
          children: [
            { ...dirEntry("src", "directory"), children: [dirEntry("index.ts", "file")] },
            dirEntry("package.json", "file"),
          ],
        };
      }
      return [dirEntry("package.json", "file")];
    });
    const provider = new VertraFileSystemProvider(client);

    await Promise.all([
      provider.stat(remoteUri("app-1", "package.json")),
      provider.stat(remoteUri("app-1", "src")),
      provider.readDirectory(remoteUri("app-1", "")),
    ]);
    const nested = await provider.readDirectory(remoteUri("app-1", "src"));

    assert.deepEqual(nested, [["index.ts", FileType.File]]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].path.endsWith("/files/tree"));
  });

  it("serve o cache antigo durante o cooldown de rate limit", async () => {
    let fail = false;
    const { client, calls } = fakeClient((call) => {
      if (call.path.endsWith("/files/tree")) {return new Error("no tree");}
      if (fail) {return Object.assign(new Error("Too many requests"), { code: "RATE_LIMIT_EXCEEDED", status: 429, retryAfter: 6 });}
      return [dirEntry("a.txt", "file")];
    });
    const provider = new VertraFileSystemProvider(client);
    const root = remoteUri("app-1", "");

    await provider.readDirectory(root);
    fail = true;
    (provider as unknown as { dirs: Map<string, { at: number }> }).dirs.get("app-1:")!.at = 0;
    const again = await provider.readDirectory(root);
    const third = await provider.readDirectory(root);

    assert.deepEqual(again, [["a.txt", FileType.File]]);
    assert.deepEqual(third, again);
    assert.equal(calls.filter((c) => c.path.endsWith("/files") && c.method === "GET").length, 2);
  });
});

describe("invalidateApp", () => {
  it("descarta o cache do app e avisa o Explorer", async () => {
    let version = "old";
    const { client } = fakeClient((call) => {
      if (call.path.endsWith("/files/tree")) {return new Error("no tree");}
      return [dirEntry(`${version}.txt`, "file")];
    });
    const provider = new VertraFileSystemProvider(client);
    const events: unknown[] = [];
    provider.onDidChangeFile((e) => events.push(e));

    await provider.readDirectory(remoteUri("app-1", ""));
    version = "new";
    provider.invalidateApp("app-1");
    const after = await provider.readDirectory(remoteUri("app-1", ""));

    assert.deepEqual(after, [["new.txt", FileType.File]]);
    assert.equal(events.length, 1);
  });
});
