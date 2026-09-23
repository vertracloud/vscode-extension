import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as vscodeMock from "vscode";
import type { APIDatabase } from "@vertracloud/api-types/v1";
import { ApiClient } from "../src/api/client";
import {
  createDatabase,
  downloadDatabaseCertificate,
  resetDatabasePassword,
} from "../src/api/databases";
import { registerDatabasesCommands } from "../src/commands/databases";
import { registeredCommands, createFakeOutputChannel, type FakeOutputChannel } from "./vscode-mock";
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

  it("downloads the certificate as a raw buffer", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(bytes as BodyInit, { status: 200 });
    });
    const buffer = await downloadDatabaseCertificate(client(), "db-1");
    assert.equal(calls[0].url, `${BASE}/v1/databases/db-1/credentials/certificate`);
    assert.deepEqual(new Uint8Array(buffer), bytes);
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
        owner_plan_id: 1,
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

    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.type, 3);
    assert.equal(body.ram, 512);
    assert.equal(body.name, "cache");
    assert.equal(refreshCalls, 1);
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

  it("downloadCertificate writes the received buffer", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    vi.stubGlobal("fetch", async () => new Response(bytes, { status: 200 }));

    let written: Uint8Array | undefined;
    const originalWriteFile = vscodeMock.workspace.fs.writeFile;
    const originalSaveDialog = (vscodeMock.window as unknown as { showSaveDialog: unknown }).showSaveDialog;
    (vscodeMock.window as unknown as { showSaveDialog: (...a: unknown[]) => Promise<unknown> }).showSaveDialog =
      async () => vscodeMock.Uri.file("/tmp/my-db-ca.pem");
    vscodeMock.workspace.fs.writeFile = async (_uri, content: Uint8Array) => {
      written = content;
    };

    try {
      await run(fakeDeps(), "vertraCloud.db.downloadCertificate");
    } finally {
      vscodeMock.workspace.fs.writeFile = originalWriteFile;
      (vscodeMock.window as unknown as { showSaveDialog: unknown }).showSaveDialog = originalSaveDialog;
    }

    assert.deepEqual(written, bytes);
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
