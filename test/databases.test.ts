import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as vscodeMock from "vscode";
import type { APIDatabase } from "@vertracloud/api-types/v1";
import { ApiClient } from "../src/api/client";
import {
  createDatabase,
  getDatabaseCertificate,
  resetDatabasePassword,
} from "../src/api/databases";
import { registerDatabasesCommands } from "../src/commands/databases";
import { registeredCommands, createFakeOutputChannel, env as mockEnv, type FakeOutputChannel } from "./vscode-mock";
import type { CommandDeps } from "../src/commands/deps";
import type { DbEntry } from "../src/state";

const BASE = "https://api.vertracloud.app";

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(response: unknown = { response: [] }, status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

const client = () => new ApiClient(async () => "tok", "vertra-cloud-vscode/1.0.0");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api/databases", () => {
  it("create sends the numeric type for each engine", async () => {
    const calls = stubFetch({ response: {} });
    await createDatabase(client(), { name: "db1", ram: 1024, type: 1 });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.type, 1);

    await createDatabase(client(), { name: "db2", ram: 512, type: 3 });
    const body2 = JSON.parse(calls[1].init.body as string);
    assert.equal(body2.type, 3);
  });

  it("getDatabaseCertificate reads the JSON envelope instead of raw bytes", async () => {
    const calls = stubFetch({ response: { crt: "C", key: "K", pem: "P", ca: "CA-PEM" } });
    const cert = await getDatabaseCertificate(client(), "db-1");
    assert.equal(calls[0].url, `${BASE}/v1/databases/db-1/credentials/certificate`);
    assert.equal(cert.ca, "CA-PEM");
  });

  it("resets the password and returns it once", async () => {
    stubFetch({ response: { password: "s3cr3t" } });
    const result = await resetDatabasePassword(client(), "db-1");
    assert.equal(result.password, "s3cr3t");
  });
});

describe("commands/databases", () => {
  let showQuickPickCalls: unknown[][];
  let showInputBoxCalls: unknown[][];
  let showInformationMessageCalls: unknown[][];
  let quickPickQueue: unknown[];
  let inputBoxQueue: (string | undefined)[];
  let informationMessageQueue: (string | undefined)[];
  let confirmDangerResult: boolean;
  let refreshCalls: number;
  let channel: FakeOutputChannel;

  const w = vscodeMock.window as unknown as {
    showQuickPick: (...args: unknown[]) => Promise<unknown>;
    showInputBox: (...args: unknown[]) => Promise<unknown>;
    showInformationMessage: (...args: unknown[]) => Promise<unknown>;
  };

  beforeEach(() => {
    showQuickPickCalls = [];
    showInputBoxCalls = [];
    showInformationMessageCalls = [];
    quickPickQueue = [];
    inputBoxQueue = [];
    informationMessageQueue = [];
    confirmDangerResult = true;
    refreshCalls = 0;
    channel = createFakeOutputChannel("db");

    w.showQuickPick = async (...args: unknown[]) => {
      showQuickPickCalls.push(args);
      return quickPickQueue.shift();
    };
    w.showInputBox = async (...args: unknown[]) => {
      showInputBoxCalls.push(args);
      return inputBoxQueue.shift();
    };
    w.showInformationMessage = async (...args: unknown[]) => {
      showInformationMessageCalls.push(args);
      return informationMessageQueue.shift();
    };
  });

  function fakeDeps(db: Partial<APIDatabase> = {}): CommandDeps {
    const entry: DbEntry = {
      db: {
        id: "db-1",
        cluster: 1,
        type: 1,
        name: "my-db",
        description: "",
        owner_id: "u1",
        owner_plan: "starter-1",
        status: "up",
        ram: 1024,
        host: "vertra-cloud-postgresql-db-1.vertraweb.app",
        port: 5432,
        created_at: "",
        updated_at: "",
        last_snapshot: null,
        offline_since: null,
        ...db,
      } as APIDatabase,
      favorite: false,
    };
    return {
      context: { subscriptions: [] } as unknown as CommandDeps["context"],
      client: client(),
      session: {} as CommandDeps["session"],
      store: {} as CommandDeps["store"],
      links: {} as CommandDeps["links"],
      realtime: {} as CommandDeps["realtime"],
      getChannel: () => channel as unknown as CommandDeps extends { getChannel(...a: infer _A): infer R } ? R : never,
      refresh: async () => {
        refreshCalls++;
      },
      showError: () => {},
      pickApp: async () => undefined,
      pickDatabase: async () => entry,
      resolveApp: async () => undefined,
      resolveDatabase: async () => entry,
      confirmDanger: async () => confirmDangerResult,
    };
  }

  function run(deps: CommandDeps, id: string, arg?: unknown): Promise<unknown> {
    registerDatabasesCommands(deps);
    const handler = registeredCommands.get(id);
    assert.ok(handler, `command ${id} not registered`);
    return Promise.resolve(handler!(arg));
  }

  it("create builds the numeric type body with the minimum RAM enforced", async () => {
    const calls = stubFetch({ response: { id: "db-2" } });
    quickPickQueue = [{ engine: { type: 3, label: "Redis", minRam: 512, defaultUser: "none" } }];
    inputBoxQueue = ["cache", "512", ""];

    await run(fakeDeps(), "vertraCloud.db.create");

    const body = JSON.parse(calls.find((c) => c.init.method === "POST")!.init.body as string);
    assert.equal(body.type, 3);
    assert.equal("version" in body, false);
    assert.equal(body.ram, 512);
    assert.equal(body.name, "cache");
    assert.equal(refreshCalls, 1);
  });

  it("create shows the password once in a modal with a copy button", async () => {
    stubFetch({ response: { id: "db-1", password: "pw-once" } });
    quickPickQueue = [{ engine: { type: 3, label: "Redis", minRam: 512, defaultUser: "none" } }];
    inputBoxQueue = ["cache", "512", ""];
    await run(fakeDeps(), "vertraCloud.db.create");
    const [message, options, copy] = showInformationMessageCalls[0] as [string, { modal: boolean }, string];
    assert.ok(message.includes("pw-once"));
    assert.ok(message.includes("won't be shown again"));
    assert.equal(options.modal, true);
    assert.equal(copy, "Copy");
  });

  it("create copies the password when Copy is chosen and never logs it", async () => {
    stubFetch({ response: { id: "db-1", password: "pw-once" } });
    quickPickQueue = [{ engine: { type: 3, label: "Redis", minRam: 512, defaultUser: "none" } }];
    inputBoxQueue = ["cache", "512", ""];
    informationMessageQueue = ["Copy"];
    mockEnv.clipboard.text = "";
    await run(fakeDeps(), "vertraCloud.db.create");
    assert.equal(mockEnv.clipboard.text, "pw-once");
    assert.ok(!JSON.stringify(channel.lines).includes("pw-once"));
  });

  it("create without a password in the answer keeps the old notice", async () => {
    stubFetch({ response: { id: "db-1" } });
    quickPickQueue = [{ engine: { type: 3, label: "Redis", minRam: 512, defaultUser: "none" } }];
    inputBoxQueue = ["cache", "512", ""];
    await run(fakeDeps(), "vertraCloud.db.create");
    assert.ok((showInformationMessageCalls[0] as [string])[0].includes("shown only once"));
  });

  function stubCatalog(): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const response = url.endsWith("/v1/databases/versions")
        ? { "1": { recommended: "18", available: ["18", "17", "16"] } }
        : { id: "db-2" };
      return new Response(JSON.stringify({ response }), { status: 200, headers: { "content-type": "application/json" } });
    });
    return calls;
  }

  it("create offers the catalog versions with the recommended first and sends the chosen one", async () => {
    const calls = stubCatalog();
    quickPickQueue = [
      { engine: { type: 1, label: "PostgreSQL", minRam: 1024, defaultUser: "postgres" } },
      { label: "17", line: "17" },
    ];
    inputBoxQueue = ["db", "1024", ""];

    await run(fakeDeps(), "vertraCloud.db.create");

    const items = showQuickPickCalls[1][0] as { label: string; description?: string }[];
    assert.deepEqual(items.map((i) => i.label), ["18", "17", "16"]);
    assert.ok(items[0].description);
    assert.equal(items[1].description, undefined);
    const body = JSON.parse(calls.find((c) => c.init.method === "POST")!.init.body as string);
    assert.equal(body.version, "17");
  });

  it("create stops without calling the API when the version pick is cancelled", async () => {
    const calls = stubCatalog();
    quickPickQueue = [{ engine: { type: 1, label: "PostgreSQL", minRam: 1024, defaultUser: "postgres" } }, undefined];

    await run(fakeDeps(), "vertraCloud.db.create");

    assert.equal(calls.some((c) => c.init.method === "POST"), false);
  });

  it("create rejects RAM below the engine minimum", async () => {
    quickPickQueue = [{ engine: { type: 1, label: "PostgreSQL", minRam: 1024, defaultUser: "postgres" } }];
    inputBoxQueue = ["db"];

    await run(fakeDeps(), "vertraCloud.db.create");

    const ramBoxArgs = showInputBoxCalls[1]?.[0] as { validateInput: (v: string) => string | undefined };
    assert.ok(ramBoxArgs.validateInput("100"));
    assert.equal(ramBoxArgs.validateInput("1024"), undefined);
  });

  it("start calls the start route then refreshes", async () => {
    const calls = stubFetch({ response: true });
    await run(fakeDeps(), "vertraCloud.db.start");
    assert.equal(calls[0].url, `${BASE}/v1/databases/db-1/start?`.replace(/\?$/, ""));
    assert.equal(calls[0].init.method, "POST");
    assert.equal(refreshCalls, 1);
  });

  it("resetPassword does not call the API without confirmation", async () => {
    confirmDangerResult = false;
    const calls = stubFetch({ response: { password: "x" } });
    await run(fakeDeps(), "vertraCloud.db.resetPassword");
    assert.equal(calls.length, 0);
  });

  it("resetPassword shows the password once and never logs it to an output channel", async () => {
    stubFetch({ response: { password: "s3cr3t-pass" } });
    await run(fakeDeps(), "vertraCloud.db.resetPassword");

    assert.equal(informationMessageQueue.length, 0);
    const [message] = showInformationMessageCalls[0] as [string];
    assert.ok(message.includes("s3cr3t-pass"));
    assert.ok(message.includes("postgres"));
    assert.deepEqual(channel.lines, []);
  });

  it("resetPassword mostra o username devolvido pela api e cai no padrão do engine sem ele", async () => {
    stubFetch({ response: { password: "pw1" } });
    await run(fakeDeps({ username: "vertracloud" }), "vertraCloud.db.resetPassword");
    assert.ok((showInformationMessageCalls[0] as [string])[0].includes('user "vertracloud"'));

    showInformationMessageCalls.length = 0;
    stubFetch({ response: { password: "pw2" } });
    await run(fakeDeps({ type: 4, username: undefined }), "vertraCloud.db.resetPassword");
    assert.ok((showInformationMessageCalls[0] as [string])[0].includes('user "root"'));
  });

  async function runDownload(onWarning?: (message: string) => void): Promise<Uint8Array | undefined> {
    let written: Uint8Array | undefined;
    const originalWriteFile = vscodeMock.workspace.fs.writeFile;
    const mockWindow = vscodeMock.window as unknown as {
      showSaveDialog: unknown;
      showWarningMessage: unknown;
    };
    const originalSaveDialog = mockWindow.showSaveDialog;
    const originalWarning = mockWindow.showWarningMessage;
    mockWindow.showSaveDialog = async () => vscodeMock.Uri.file("/tmp/my-db-ca.pem");
    mockWindow.showWarningMessage = async (message: string) => {
      onWarning?.(message);
      return undefined;
    };
    vscodeMock.workspace.fs.writeFile = async (_uri, content: Uint8Array) => {
      written = content;
    };

    try {
      await run(fakeDeps(), "vertraCloud.db.downloadCertificate");
    } finally {
      vscodeMock.workspace.fs.writeFile = originalWriteFile;
      mockWindow.showSaveDialog = originalSaveDialog;
      mockWindow.showWarningMessage = originalWarning;
    }
    return written;
  }

  it("downloadCertificate writes the CA PEM, not the JSON body", async () => {
    const ca = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n";
    stubFetch({ response: { crt: "C", key: "K", pem: "P", ca } });
    const written = await runDownload();
    assert.equal(Buffer.from(written!).toString("utf8"), ca);
  });

  it("downloadCertificate warns and writes nothing when the database has no CA", async () => {
    stubFetch({ response: { crt: "C", key: "K", pem: "P" } });
    const warnings: string[] = [];
    const written = await runDownload((message) => warnings.push(message));
    assert.equal(written, undefined);
    assert.deepEqual(warnings, ["This database has no CA certificate to download."]);
  });

  it("delete only calls the API after confirmation", async () => {
    confirmDangerResult = false;
    const calls = stubFetch({ response: {} });
    await run(fakeDeps(), "vertraCloud.db.delete");
    assert.equal(calls.length, 0);

    confirmDangerResult = true;
    const calls2 = stubFetch({ response: {} });
    await run(fakeDeps(), "vertraCloud.db.delete");
    assert.equal(calls2[0].init.method, "DELETE");
    assert.equal(refreshCalls, 1);
  });
});
