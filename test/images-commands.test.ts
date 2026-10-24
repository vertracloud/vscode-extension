import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as vscodeMock from "vscode";
import type { APICustomImage, APIDockerfileCheck } from "@vertracloud/api-types/v1";
import { EventEmitter, FakeMemento, createFakeOutputChannel, registeredCommands } from "./vscode-mock";
import { registerImages, reviewDockerfileCheck } from "../src/images/commands";
import type { CommandDeps } from "../src/commands/deps";

const win = vscodeMock.window as unknown as Record<string, (...args: unknown[]) => unknown>;
const original = { ...win };

function image(overrides: Partial<APICustomImage> = {}): APICustomImage {
  return {
    id: "img1",
    name: "web",
    description: null,
    owner: "account",
    status: "success",
    error: null,
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    uncompressed_bytes: 1000,
    layer_count: 3,
    suggested_port: null,
    apps: [],
    github: null,
    current_version_id: "v1",
    created_at: "2026-10-20T10:00:00.000Z",
    updated_at: "2026-10-22T10:00:00.000Z",
    ...overrides,
  };
}

interface Call {
  path: string;
  method: string;
  query?: Record<string, unknown>;
  body?: unknown;
  form?: FormData;
}

interface Setup {
  deps: CommandDeps;
  calls: Call[];
  errors: unknown[];
  refreshed: { value: number };
  memento: FakeMemento;
  polled: string[];
  setStream(body: ReadableStream<Uint8Array>): void;
  channels: Map<string, ReturnType<typeof createFakeOutputChannel>>;
}

function setup(handler: (call: Call) => unknown, workspaces: Array<{ id: string; name: string }> = []): Setup {
  const calls: Call[] = [];
  const errors: unknown[] = [];
  const polled: string[] = [];
  const refreshed = { value: 0 };
  const memento = new FakeMemento();
  let stream: ReadableStream<Uint8Array> = new ReadableStream({ start: (c) => c.close() });
  const client = {
    request: async (p: string, opts: { method?: string; query?: Record<string, unknown>; body?: unknown; form?: FormData } = {}) => {
      const call: Call = { path: p, method: opts.method ?? "GET", query: opts.query, body: opts.body, form: opts.form };
      calls.push(call);
      const result = handler(call);
      if (result instanceof Error) {throw result;}
      return result;
    },
    stream: async (p: string, opts: { query?: Record<string, unknown> }) => {
      calls.push({ path: p, method: "STREAM", query: opts.query });
      return stream;
    },
  };
  const channels = new Map<string, ReturnType<typeof createFakeOutputChannel>>();
  win.createOutputChannel = (name: unknown) => {
    const channel = createFakeOutputChannel(String(name));
    channels.set(String(name), channel);
    return channel;
  };
  const deps = {
    context: { subscriptions: [], workspaceState: memento },
    client,
    session: { onDidChange: new EventEmitter<void>().event },
    store: {
      workspaces,
      onDidChange: new EventEmitter<void>().event,
      pollAfterMutation: async (id: string) => {
        polled.push(id);
      },
    },
    refresh: async () => {
      refreshed.value++;
    },
    showError: (err: unknown) => errors.push(err),
    confirmDanger: async () => true,
  } as unknown as CommandDeps;
  registerImages(deps);
  return { deps, calls, errors, refreshed, memento, polled, setStream: (b) => (stream = b), channels };
}

async function run(id: string, ...args: unknown[]): Promise<void> {
  const handler = registeredCommands.get(id);
  assert.ok(handler, `command ${id} is not registered`);
  await handler(...args);
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vertra-image-cmd-"));
  (vscodeMock.workspace as { isTrusted: boolean }).isTrusted = true;
  (vscodeMock.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
});

afterEach(async () => {
  Object.assign(win, original);
  await fs.rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

const cleanCheck: APIDockerfileCheck = { refusals: [], warnings: [], suggested_port: 3000 };

/** Answers every dialog of the "from a folder" flow. */
function answerFolderFlow(opts: { name?: string; onWarning?: (detail: string) => string | undefined } = {}): { shown: string[] } {
  const shown: string[] = [];
  win.showQuickPick = async (items: unknown) => {
    const list = items as Array<string | { label: string; fsPath?: string }>;
    const first = list[0];
    if (typeof first === "string") {return first;}
    return list.find((i) => typeof i !== "string" && i.label.includes("Folder")) ?? first;
  };
  win.showOpenDialog = async () => [vscodeMock.Uri.file(root)];
  win.showInputBox = async () => opts.name ?? "web";
  win.showWarningMessage = async (message: unknown, options: unknown, ...items: unknown[]) => {
    shown.push(`${String(message)} | ${(options as { detail?: string })?.detail ?? ""}`);
    if (opts.onWarning) {return opts.onWarning((options as { detail?: string })?.detail ?? "");}
    return items[0];
  };
  win.showInformationMessage = async (message: unknown) => {
    shown.push(String(message));
    return undefined;
  };
  win.showErrorMessage = async (message: unknown, options: unknown) => {
    shown.push(`ERROR ${String(message)} | ${(options as { detail?: string })?.detail ?? ""}`);
    return undefined;
  };
  return { shown };
}

describe("reviewDockerfileCheck", () => {
  it("lets a clean check through without any dialog", async () => {
    win.showErrorMessage = async () => assert.fail("no dialog expected");
    win.showWarningMessage = async () => assert.fail("no dialog expected");
    assert.equal(await reviewDockerfileCheck(cleanCheck), true);
  });

  it("blocks on refusals and lists them with the line", async () => {
    let detail = "";
    win.showErrorMessage = async (_m: unknown, options: unknown) => {
      detail = (options as { detail: string }).detail;
    };
    const ok = await reviewDockerfileCheck({ ...cleanCheck, refusals: [{ code: "run_network_host", line: 5 }] });
    assert.equal(ok, false);
    assert.match(detail, /Line 5: RUN --network=host/);
  });

  it("asks before building with warnings, and cancelling stops", async () => {
    let detail = "";
    win.showWarningMessage = async (_m: unknown, options: unknown) => {
      detail = (options as { detail: string }).detail;
      return undefined;
    };
    const check = { ...cleanCheck, warnings: [{ code: "workdir_app" as const, line: 2 }] };
    assert.equal(await reviewDockerfileCheck(check), false);
    assert.match(detail, /Line 2: WORKDIR/);
    win.showWarningMessage = async (_m: unknown, _o: unknown, ...items: unknown[]) => items[0];
    assert.equal(await reviewDockerfileCheck(check), true);
  });
});

describe("vertraCloud.images.create (folder)", () => {
  it("checks the Dockerfile, uploads the zip with the name and remembers the suggested port", async () => {
    await project({ Dockerfile: "FROM node:22\nEXPOSE 3000\n", "src/a.js": "x", ".env": "SECRET=1" });
    answerFolderFlow({ name: "my-image" });
    const s = setup((call) => {
      if (call.path === "/v1/images/check") {return cleanCheck;}
      if (call.path === "/v1/images" && call.method === "POST") {return image({ id: "new1", name: "my-image", status: "building" });}
      return [];
    });
    await run("vertraCloud.images.create", vscodeMock.Uri.file(root));
    assert.deepEqual(s.errors, []);
    const check = s.calls.find((c) => c.path === "/v1/images/check");
    assert.deepEqual((check?.body as { files: string[] }).files.sort(), [".env", "Dockerfile", "src/a.js"]);
    assert.equal((check?.body as { dockerfile: string }).dockerfile, "FROM node:22\nEXPOSE 3000\n");
    const create = s.calls.find((c) => c.path === "/v1/images" && c.method === "POST");
    assert.ok(create?.form);
    assert.equal(create.form.get("name"), "my-image");
    const file = create.form.get("file") as File;
    assert.ok(file.size > 0);
    assert.equal(create.form.get("github_repository"), null);
    assert.equal(s.memento.get<Record<string, number>>("vertraCloud.images.suggestedPorts", {})["new1"], 3000);
  });

  it("never uploads when the check refuses", async () => {
    await project({ Dockerfile: "FROM scratch\nRUN --network=host x\n" });
    const ui = answerFolderFlow();
    const s = setup((call) => (call.path === "/v1/images/check" ? { ...cleanCheck, refusals: [{ code: "run_network_host", line: 2 }] } : []));
    await run("vertraCloud.images.create", vscodeMock.Uri.file(root));
    assert.equal(s.calls.some((c) => c.method === "POST" && c.path === "/v1/images"), false);
    assert.ok(ui.shown.some((m) => m.startsWith("ERROR") && m.includes("Line 2")));
  });

  it("never uploads when the person cancels at the warnings", async () => {
    await project({ Dockerfile: "FROM scratch\nWORKDIR /app\n" });
    answerFolderFlow({ onWarning: () => undefined });
    const s = setup((call) => (call.path === "/v1/images/check" ? { ...cleanCheck, warnings: [{ code: "workdir_app", line: 2 }] } : []));
    await run("vertraCloud.images.create", vscodeMock.Uri.file(root));
    assert.equal(s.calls.some((c) => c.method === "POST" && c.path === "/v1/images"), false);
  });

  it("refuses locally, before any request, when there is no Dockerfile", async () => {
    await project({ "index.js": "x" });
    answerFolderFlow();
    const s = setup(() => []);
    await run("vertraCloud.images.create", vscodeMock.Uri.file(root));
    assert.equal(s.calls.length, 0);
    assert.equal((s.errors[0] as { code: string }).code, "DOCKERFILE_NOT_FOUND");
  });

  it("is disabled in an untrusted workspace", async () => {
    await project({ Dockerfile: "FROM scratch\n" });
    answerFolderFlow();
    (vscodeMock.workspace as { isTrusted: boolean }).isTrusted = false;
    const s = setup(() => []);
    await run("vertraCloud.images.create", vscodeMock.Uri.file(root));
    assert.equal(s.calls.length, 0);
    assert.equal((s.errors[0] as { code: string }).code, "WORKSPACE_NOT_TRUSTED");
  });

  it("creates in the workspace chosen from the workspace node", async () => {
    await project({ Dockerfile: "FROM scratch\n" });
    answerFolderFlow();
    const s = setup((call) => (call.path === "/v1/images/check" ? cleanCheck : call.method === "POST" ? image({ status: "building" }) : []), [{ id: "ws1", name: "Team" }]);
    await run("vertraCloud.images.create", { kind: "workspace", workspaceId: "ws1", name: "Team" });
    const create = s.calls.find((c) => c.path === "/v1/images" && c.method === "POST");
    assert.equal(create?.form?.get("workspace_id"), "ws1");
  });
});

describe("vertraCloud.images.create (GitHub)", () => {
  it("sends the repository and branch and no file", async () => {
    let step = 0;
    win.showQuickPick = async (items: unknown) => (items as string[]).find((i) => i.includes("GitHub"));
    win.showInputBox = async () => ["from-git", "owner/repo", "release"][step++];
    win.showInformationMessage = async () => undefined;
    const s = setup((call) => (call.method === "POST" ? image({ status: "building" }) : []));
    await run("vertraCloud.images.create");
    const create = s.calls.find((c) => c.path === "/v1/images" && c.method === "POST");
    assert.equal(create?.form?.get("github_repository"), "owner/repo");
    assert.equal(create?.form?.get("github_branch"), "release");
    assert.equal(create?.form?.get("file"), null);
    assert.equal(s.calls.some((c) => c.path === "/v1/images/check"), false);
  });
});

describe("vertraCloud.images.create (GitHub, default branch)", () => {
  it("sends no branch when the branch input is left empty", async () => {
    let step = 0;
    win.showQuickPick = async (items: unknown) => (items as string[]).find((i) => i.includes("GitHub"));
    win.showInputBox = async () => ["from-git", "owner/repo", ""][step++];
    win.showInformationMessage = async () => undefined;
    const s = setup((call) => (call.method === "POST" ? image({ status: "building" }) : []));
    await run("vertraCloud.images.create");
    const create = s.calls.find((c) => c.path === "/v1/images" && c.method === "POST");
    assert.equal(create?.form?.get("github_repository"), "owner/repo");
    assert.equal(create?.form?.has("github_branch"), false);
  });

  it("cancels when the branch input is dismissed", async () => {
    let step = 0;
    win.showQuickPick = async (items: unknown) => (items as string[]).find((i) => i.includes("GitHub"));
    win.showInputBox = async () => ["from-git", "owner/repo", undefined][step++];
    const s = setup(() => image({ status: "building" }));
    await run("vertraCloud.images.create");
    assert.equal(s.calls.some((c) => c.path === "/v1/images" && c.method === "POST"), false);
  });
});

describe("vertraCloud.images.rebuild", () => {
  it("replaces the context with PUT after confirming, and says apps are not restarted", async () => {
    await project({ Dockerfile: "FROM scratch\n" });
    const ui = answerFolderFlow();
    const s = setup((call) => {
      if (call.path === "/v1/images/img1" && call.method === "GET") {return image();}
      if (call.path === "/v1/images/check") {return cleanCheck;}
      if (call.method === "PUT") {return image({ status: "building" });}
      return [];
    });
    await run("vertraCloud.images.rebuild", { kind: "image", image: image() });
    const put = s.calls.find((c) => c.method === "PUT");
    assert.equal(put?.path, "/v1/images/img1");
    assert.ok(put?.form?.get("file"));
    assert.equal(put?.form?.get("name"), null);
    assert.ok(ui.shown.some((m) => m.includes("not restarted")));
  });

  it("refuses without uploading while another build runs", async () => {
    await project({ Dockerfile: "FROM scratch\n" });
    answerFolderFlow();
    const s = setup((call) => (call.method === "GET" ? image({ status: "building" }) : []));
    await run("vertraCloud.images.rebuild", { kind: "image", image: image() });
    assert.equal(s.calls.some((c) => c.method === "PUT"), false);
    assert.equal((s.errors[0] as { code: string }).code, "IMAGE_BUILD_IN_PROGRESS");
  });

  it("does not touch an image of the platform", async () => {
    answerFolderFlow();
    const s = setup(() => []);
    await run("vertraCloud.images.rebuild", { kind: "image", image: image({ owner: "system" }) });
    assert.equal(s.calls.length, 0);
  });
});

describe("vertraCloud.images.delete", () => {
  it("warns about the apps and the apps:delete scope, then sends confirm_name", async () => {
    const ui = answerFolderFlow();
    const withApps = image({ apps: [{ id: "a", name: "a", version_id: "v1", outdated: false }, { id: "b", name: "b", version_id: "v1", outdated: false }] });
    const s = setup((call) => (call.method === "DELETE" ? { deleted_apps: ["a", "b"] } : call.method === "GET" ? withApps : []));
    await run("vertraCloud.images.delete", { kind: "image", image: withApps, workspaceId: "ws1" });
    const del = s.calls.find((c) => c.method === "DELETE");
    assert.deepEqual(del?.body, { confirm_name: "web" });
    assert.equal(del?.query?.workspace_id, "ws1");
    assert.ok(ui.shown.some((m) => m.includes("2 application(s)") && m.includes("apps:delete")));
    assert.equal(s.refreshed.value, 1);
  });

  it("reads the image again before warning: a stale tree with 0 apps still warns about the app the server has", async () => {
    const ui = answerFolderFlow();
    const fresh = image({ name: "renamed", apps: [{ id: "a", name: "a", version_id: "v1", outdated: false }] });
    const confirmed: string[] = [];
    const s = setup((call) => (call.method === "DELETE" ? { deleted_apps: ["a"] } : call.method === "GET" ? fresh : []));
    (s.deps as unknown as { confirmDanger: (n: string) => Promise<boolean> }).confirmDanger = async (n) => {
      confirmed.push(n);
      return true;
    };
    await run("vertraCloud.images.delete", { kind: "image", image: image() });
    assert.ok(ui.shown.some((m) => m.includes("1 application(s)")));
    assert.ok(ui.shown.some((m) => m.includes("renamed")));
    assert.deepEqual(confirmed, ["renamed"]);
    const del = s.calls.find((c) => c.method === "DELETE");
    assert.deepEqual(del?.body, { confirm_name: "renamed" });
  });

  it("does not delete when the typed name check fails", async () => {
    answerFolderFlow();
    const s = setup((call) => (call.method === "GET" ? image() : []));
    (s.deps as unknown as { confirmDanger: () => Promise<boolean> }).confirmDanger = async () => false;
    await run("vertraCloud.images.delete", { kind: "image", image: image() });
    assert.equal(s.calls.some((c) => c.method === "DELETE"), false);
  });

  it("does not delete when the first warning is dismissed", async () => {
    answerFolderFlow({ onWarning: () => undefined });
    const s = setup((call) => (call.method === "GET" ? image() : []));
    await run("vertraCloud.images.delete", { kind: "image", image: image() });
    assert.equal(s.calls.some((c) => c.method === "DELETE"), false);
  });

  it("surfaces a missing apps:delete scope through the shared error handler", async () => {
    answerFolderFlow();
    const denied = Object.assign(new Error("denied"), { code: "API_KEY_SCOPE_DENIED", details: { required: "apps:delete" } });
    const s = setup((call) => (call.method === "DELETE" ? denied : call.method === "GET" ? image() : []));
    await run("vertraCloud.images.delete", { kind: "image", image: image() });
    assert.equal(s.errors[0], denied);
  });
});

describe("vertraCloud.images.createApp", () => {
  function answers(values: { title: string; value: string | undefined }[], web: "yes" | "no"): void {
    win.showInputBox = async (options: unknown) => {
      const title = (options as { title: string }).title;
      const found = values.find((v) => title.startsWith(v.title));
      return found ? found.value : "";
    };
    win.showQuickPick = async (items: unknown) => (items as string[])[web === "yes" ? 0 : 1];
    win.showInformationMessage = async () => undefined;
  }

  it("creates a web app with the suggested port pre-filled and the envs", async () => {
    let portDefault: string | undefined;
    let secretWasMasked = false;
    let envStep = 0;
    win.showInputBox = async (options: unknown) => {
      const o = options as { title: string; value?: string; password?: boolean };
      if (o.title.startsWith("Application name")) {return "api";}
      if (o.title.startsWith("Memory")) {return "1024";}
      if (o.title.startsWith("Subdomain")) {return "my-api";}
      if (o.title.startsWith("Port")) {
        portDefault = o.value;
        return "3000";
      }
      if (o.title.startsWith("Environment variable name")) {return envStep++ === 0 ? "TOKEN" : "";}
      if (o.title.startsWith("Value of")) {
        secretWasMasked = o.password === true;
        return "s3cret";
      }
      return "";
    };
    win.showQuickPick = async (items: unknown) => (items as string[])[0];
    win.showInformationMessage = async () => undefined;
    const s = setup((call) => (call.path === "/v1/apps/image" ? { id: "app9", name: "api", status: "building" } : []));
    await s.memento.update("vertraCloud.images.suggestedPorts", { img1: 8080 });
    await run("vertraCloud.images.createApp", { kind: "image", image: image(), workspaceId: "ws1" });
    assert.deepEqual(s.errors, []);
    assert.equal(portDefault, "8080");
    assert.equal(secretWasMasked, true);
    const create = s.calls.find((c) => c.path === "/v1/apps/image");
    assert.deepEqual(create?.body, {
      image_id: "img1",
      name: "api",
      memory: 1024,
      web: true,
      subdomain: "my-api",
      port: 3000,
      envs: [{ key: "TOKEN", value: "s3cret" }],
      workspace_id: "ws1",
    });
    assert.deepEqual(s.polled, ["app9"]);
  });

  it("pre-fills the port with the image's suggested_port from the API before the local hint", async () => {
    let portDefault: string | undefined;
    win.showInputBox = async (options: unknown) => {
      const o = options as { title: string; value?: string };
      if (o.title.startsWith("Port")) {portDefault = o.value;}
      return o.title.startsWith("Application name") ? "x" : o.title.startsWith("Memory") ? "512" : o.title.startsWith("Port") ? "4000" : o.title.startsWith("Subdomain") ? "" : "";
    };
    win.showQuickPick = async (items: unknown) => (items as string[])[0];
    win.showInformationMessage = async () => undefined;
    const s = setup((call) => (call.path === "/v1/apps/image" ? { id: "a", name: "x", status: "building" } : []));
    await s.memento.update("vertraCloud.images.suggestedPorts", { img1: 8080 });
    await run("vertraCloud.images.createApp", { kind: "image", image: { ...image(), suggested_port: 4000 } });
    assert.equal(portDefault, "4000");
  });

  it("falls back to port 80 when no hint is known", async () => {
    let portDefault: string | undefined;
    win.showInputBox = async (options: unknown) => {
      const o = options as { title: string; value?: string };
      if (o.title.startsWith("Port")) {portDefault = o.value;}
      return o.title.startsWith("Application name") ? "x" : o.title.startsWith("Memory") ? "512" : o.title.startsWith("Port") ? "80" : "";
    };
    win.showQuickPick = async (items: unknown) => (items as string[])[0];
    win.showInformationMessage = async () => undefined;
    setup((call) => (call.path === "/v1/apps/image" ? { id: "a", name: "x", status: "building" } : []));
    await run("vertraCloud.images.createApp", { kind: "image", image: image() });
    assert.equal(portDefault, "80");
  });

  it("an app without web has no subdomain and no port prompts", async () => {
    const prompts: string[] = [];
    win.showInputBox = async (options: unknown) => {
      const title = (options as { title: string }).title;
      prompts.push(title);
      return title.startsWith("Application name") ? "bot" : title.startsWith("Memory") ? "256" : "";
    };
    win.showQuickPick = async (items: unknown) => (items as string[])[1];
    win.showInformationMessage = async () => undefined;
    const s = setup((call) => (call.path === "/v1/apps/image" ? { id: "a", name: "bot", status: "building" } : []));
    await run("vertraCloud.images.createApp", { kind: "image", image: image() });
    assert.ok(!prompts.some((p) => p.startsWith("Subdomain") || p.startsWith("Port")));
    const body = s.calls.find((c) => c.path === "/v1/apps/image")?.body as Record<string, unknown>;
    assert.equal(body.web, false);
    assert.ok(!("subdomain" in body) && !("port" in body));
  });

  it("refuses an image that is not ready, without asking anything", async () => {
    answers([], "yes");
    const s = setup(() => []);
    await run("vertraCloud.images.createApp", { kind: "image", image: image({ status: "building" }) });
    assert.equal((s.errors[0] as { code: string }).code, "IMAGE_NOT_READY");
    assert.equal(s.calls.length, 0);
  });

  it("cancelling any prompt creates nothing", async () => {
    win.showInputBox = async (options: unknown) => ((options as { title: string }).title.startsWith("Application name") ? "x" : undefined);
    const s = setup(() => []);
    await run("vertraCloud.images.createApp", { kind: "image", image: image() });
    assert.equal(s.calls.some((c) => c.path === "/v1/apps/image"), false);
  });
});

describe("vertraCloud.images.showBuildLog", () => {
  const enc = new TextEncoder();
  const sse = (...lines: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) {c.enqueue(enc.encode(`event: log\ndata: ${l}\n\n`));}
        c.close();
      },
    });

  it("replays the log into its own output channel, with the workspace and version", async () => {
    const s = setup((call) => (call.method === "GET" ? image({ status: "success" }) : []));
    s.setStream(sse("Step 1/2", "Step 2/2"));
    await run("vertraCloud.images.showBuildLog", { kind: "image", image: image(), workspaceId: "ws1" });
    const stream = s.calls.find((c) => c.method === "STREAM");
    assert.equal(stream?.path, "/v1/images/img1/logs");
    assert.equal(stream?.query?.workspace_id, "ws1");
    const channel = [...s.channels.values()][0];
    assert.equal(channel.lines[0], "Step 1/2");
    assert.equal(channel.lines[1], "Step 2/2");
    assert.match(channel.lines.at(-1) ?? "", /End of the build log/);
  });

  it("shows a translated error when the log can't be opened", async () => {
    const s = setup(() => []);
    (s.deps.client as unknown as { stream: () => Promise<never> }).stream = async () => {
      throw Object.assign(new Error("x"), { code: "IMAGE_NOT_FOUND" });
    };
    await run("vertraCloud.images.showBuildLog", { kind: "image", image: image() });
    assert.equal((s.errors[0] as { code: string }).code, "IMAGE_NOT_FOUND");
  });
});

describe("vertraCloud.images.versions", () => {
  it("lists the versions and opens the log of the chosen one", async () => {
    const enc = new TextEncoder();
    let picks = 0;
    win.showQuickPick = async (items: unknown) => {
      picks++;
      const list = items as Array<string | { version?: unknown }>;
      return picks === 1 ? list[0] : (list as string[])[0];
    };
    const s = setup((call) => {
      if (call.path.endsWith("/versions")) {
        return [{ id: "ver9", digest: "sha256:" + "b".repeat(64), source: "commit", message: "fix", created_at: "2026-10-21T10:00:00.000Z", in_use: true }];
      }
      return image();
    });
    s.setStream(new ReadableStream({ start: (c) => { c.enqueue(enc.encode("event: log\ndata: old\n\n")); c.close(); } }));
    await run("vertraCloud.images.versions", { kind: "image", image: image() });
    const stream = s.calls.find((c) => c.method === "STREAM");
    assert.equal(stream?.query?.version_id, "ver9");
  });
});

describe("rename and edit description", () => {
  it("renames with a PATCH carrying only the name, in the workspace of the image", async () => {
    let shownValue: unknown;
    win.showInputBox = async (options: unknown) => {
      shownValue = (options as { value?: string }).value;
      return "  api-v2  ";
    };
    win.showInformationMessage = async () => undefined;
    const s = setup(() => image({ name: "api-v2" }));
    await run("vertraCloud.images.rename", { kind: "image", image: image(), workspaceId: "ws1" });
    assert.equal(shownValue, "web");
    const patch = s.calls.find((c) => c.method === "PATCH");
    assert.equal(patch?.path, "/v1/images/img1");
    assert.deepEqual(patch?.body, { name: "api-v2" });
    assert.equal(patch?.query?.workspace_id, "ws1");
    assert.deepEqual(s.errors, []);
  });

  it("does nothing when the name is cancelled or unchanged, and validates 1 to 50 characters", async () => {
    let validate: ((v: string) => string | undefined) | undefined;
    win.showInputBox = async (options: unknown) => {
      validate = (options as { validateInput: (v: string) => string | undefined }).validateInput;
      return undefined;
    };
    const s = setup(() => image());
    await run("vertraCloud.images.rename", { kind: "image", image: image() });
    assert.equal(s.calls.some((c) => c.method === "PATCH"), false);
    assert.ok(validate);
    assert.ok(validate!("   "));
    assert.ok(validate!("x".repeat(51)));
    assert.equal(validate!("x".repeat(50)), undefined);
    win.showInputBox = async () => "web";
    await run("vertraCloud.images.rename", { kind: "image", image: image() });
    assert.equal(s.calls.some((c) => c.method === "PATCH"), false);
  });

  it("refuses a platform image without calling the API", async () => {
    win.showInputBox = async () => "other";
    win.showInformationMessage = async () => undefined;
    const s = setup(() => image());
    await run("vertraCloud.images.rename", { kind: "image", image: image({ owner: "system" }) });
    await run("vertraCloud.images.editDescription", { kind: "image", image: image({ owner: "system" }) });
    assert.equal(s.calls.length, 0);
  });

  it("shows the API error when the name is already in use", async () => {
    win.showInputBox = async () => "taken";
    const taken = new Error("name in use") as Error & { code: string };
    taken.code = "VALIDATION_ERROR";
    const s = setup(() => taken);
    await run("vertraCloud.images.rename", { kind: "image", image: image() });
    assert.equal(s.errors.length, 1);
  });

  it("edits the description starting from the current one", async () => {
    let shown: { value?: string; validateInput?: (v: string) => string | undefined } = {};
    win.showInputBox = async (options: unknown) => {
      shown = options as typeof shown;
      return "  New text ";
    };
    win.showInformationMessage = async () => undefined;
    const s = setup(() => image());
    await run("vertraCloud.images.editDescription", { kind: "image", image: image({ description: "Old text" }) });
    assert.equal(shown.value, "Old text");
    assert.equal(shown.validateInput?.("x".repeat(129)) !== undefined, true);
    assert.equal(shown.validateInput?.("x".repeat(128)), undefined);
    const patch = s.calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch?.body, { description: "New text" });
  });

  it("removes the description with null when the input is emptied, and skips an unchanged one", async () => {
    win.showInputBox = async () => "";
    win.showInformationMessage = async () => undefined;
    const s = setup(() => image());
    await run("vertraCloud.images.editDescription", { kind: "image", image: image({ description: "Old text" }) });
    assert.deepEqual(s.calls.find((c) => c.method === "PATCH")?.body, { description: null });
    const before = s.calls.length;
    await run("vertraCloud.images.editDescription", { kind: "image", image: image({ description: null }) });
    assert.equal(s.calls.length, before);
    win.showInputBox = async () => undefined;
    await run("vertraCloud.images.editDescription", { kind: "image", image: image({ description: "Old text" }) });
    assert.equal(s.calls.length, before);
  });
});

describe("GitHub link", () => {
  it("links with repository and branch", async () => {
    let step = 0;
    win.showInputBox = async () => ["owner/repo", "main"][step++];
    win.showInformationMessage = async () => undefined;
    const s = setup(() => image());
    await run("vertraCloud.images.linkGithub", { kind: "image", image: image() });
    const put = s.calls.find((c) => c.method === "PUT");
    assert.equal(put?.path, "/v1/images/img1/github");
    assert.deepEqual(put?.body, { repository: "owner/repo", branch: "main" });
  });

  it("links with the repository only when the branch input is left empty", async () => {
    let step = 0;
    win.showInputBox = async () => ["owner/repo", ""][step++];
    win.showInformationMessage = async () => undefined;
    const s = setup(() => image());
    await run("vertraCloud.images.linkGithub", { kind: "image", image: image() });
    const put = s.calls.find((c) => c.method === "PUT");
    assert.deepEqual(put?.body, { repository: "owner/repo" });
  });

  it("unlinks only after confirming", async () => {
    win.showWarningMessage = async () => undefined;
    const s = setup(() => image());
    await run("vertraCloud.images.unlinkGithub", { kind: "image", image: image({ github: { repository: "o/r", branch: "b" } }) });
    assert.equal(s.calls.some((c) => c.method === "DELETE"), false);
    win.showWarningMessage = async (_m: unknown, _o: unknown, ...items: unknown[]) => items[0];
    await run("vertraCloud.images.unlinkGithub", { kind: "image", image: image({ github: { repository: "o/r", branch: "b" } }) });
    assert.equal(s.calls.find((c) => c.method === "DELETE")?.path, "/v1/images/img1/github");
  });
});

describe("build log guards", () => {
  it("two quick requests for the same log open one stream", async () => {
    const s = setup((call) => (call.method === "GET" ? image() : []));
    const node = { kind: "image", image: image() };
    await Promise.all([run("vertraCloud.images.showBuildLog", node), run("vertraCloud.images.showBuildLog", node)]);
    assert.equal(s.calls.filter((c) => c.method === "STREAM").length, 1);
  });

  it("opens the log from just an image id (the deploy of an image app)", async () => {
    const s = setup((call) => (call.method === "GET" ? image({ id: "img7", name: "from-id" }) : []));
    await run("vertraCloud.images.showBuildLog", { imageId: "img7" });
    assert.equal(s.calls.find((c) => c.method === "STREAM")?.path, "/v1/images/img7/logs");
    assert.ok([...s.channels.keys()].some((name) => name.includes("from-id")));
  });
});

describe("vertraCloud.images.downloadContext", () => {
  it("sanitizes the suggested file name", async () => {
    answerFolderFlow();
    let suggested = "";
    win.showSaveDialog = async (options: unknown) => {
      suggested = (options as { defaultUri: { fsPath: string } }).defaultUri.fsPath;
      return undefined;
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array([1]))) as typeof fetch;
    try {
      setup((call) => (call.path.endsWith("/context") ? { url: "https://storage.example/ctx.zip" } : []));
      await run("vertraCloud.images.downloadContext", { kind: "image", image: image({ name: 'a/b\\c:d*e?"f<g>h|i' }) });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(suggested.replace(/^.*\//, ""), "a_b_c_d_e__f_g_h_i-context.zip".replace("e__f", "e__f"));
  });
});
