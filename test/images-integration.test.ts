import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as vscode from "vscode";
import { FakeMemento, registeredCommands, Uri } from "./vscode-mock";
import { isImageApp, summarizeImageCommit } from "../src/images/app";
import { registerNetworkCommands } from "../src/commands/network";
import { registerSnapshotsCommands } from "../src/commands/snapshots";
import { registerAppsExtraCommands } from "../src/commands/apps-extra";
import { registerProjectCommands } from "../src/commands/project";
import { buildConfigFromApp } from "../src/project/config";
import { appTreeItem } from "../src/views/items";
import type { CommandDeps } from "../src/commands/deps";
import type { AppEntry } from "../src/state";

let deployImplementation: typeof import("../src/deploy/deploy").deployToApp = async () => ({});
vi.mock("../src/deploy/deploy", () => ({
  deployToApp: (...args: Parameters<typeof deployImplementation>) => deployImplementation(...args),
  createAppFromFolder: async () => ({}),
}));

const win = vscode.window as unknown as Record<string, (...args: unknown[]) => unknown>;
const original = { ...win };

const imageApp = (extra: Record<string, unknown> = {}) =>
  ({
    id: "app-1",
    name: "My App",
    ram: 512,
    status: "up",
    public_url: null,
    domains: [],
    language: "docker",
    custom_image: { id: "x", name: "x", image_id: "img1", version_id: "v1", outdated: false, port: null },
    ...extra,
  }) as unknown as AppEntry["app"];

const regularApp = () => ({ id: "app-1", name: "My App", ram: 512, status: "up", public_url: null, domains: [], language: "javascript" }) as unknown as AppEntry["app"];

type Call = { path: string; opts?: Record<string, unknown> };

function fakeDeps(app: AppEntry["app"], handler: (path: string, opts?: Record<string, unknown>) => unknown, memento?: FakeMemento) {
  const calls: Call[] = [];
  const errors: unknown[] = [];
  const entry: AppEntry = { app, favorite: false };
  const deps = {
    client: {
      request: async (path: string, opts?: Record<string, unknown>) => {
        calls.push({ path, opts });
        const result = handler(path, opts);
        if (result instanceof Error) {throw result;}
        return result;
      },
    },
    resolveApp: async () => entry,
    showError: (err: unknown) => errors.push(err),
    confirmDanger: async () => true,
    refresh: async () => {},
    context: { subscriptions: [], workspaceState: memento ?? new FakeMemento() },
    store: { apps: [entry], pollAfterMutation: async () => {}, refresh: async () => {} },
    links: { links: [{ folder: { uri: Uri.file("/tmp/project"), name: "project", index: 0 }, appId: "app-1", source: "config" }], refresh: async () => {} },
    remoteFiles: undefined,
  } as unknown as CommandDeps;
  return { deps, calls, errors };
}

async function run(id: string, arg?: unknown): Promise<void> {
  const callback = registeredCommands.get(id);
  assert.ok(callback, `command ${id} not registered`);
  await callback(arg);
}

beforeEach(() => {
  registeredCommands.clear();
});

afterEach(() => {
  Object.assign(win, original);
  deployImplementation = async () => ({});
});

describe("isImageApp", () => {
  it("is true only when the app has a custom image (apps from older payloads have none)", () => {
    assert.equal(isImageApp(imageApp()), true);
    assert.equal(isImageApp(regularApp()), false);
    assert.equal(isImageApp({ custom_image: null }), false);
    assert.equal(isImageApp(undefined), false);
  });
});

describe("summarizeImageCommit", () => {
  it("is undefined for a regular deploy", () => {
    assert.equal(summarizeImageCommit({ app_id: "a" }), undefined);
    assert.equal(summarizeImageCommit({ image_build: null }), undefined);
    assert.equal(summarizeImageCommit(undefined), undefined);
  });

  it("uses its own text with the image name and never the server message", () => {
    const summary = summarizeImageCommit({ image_build: { image_id: "img1", build_id: "b1" }, message: "SERVER-SUMMARY" }, "base");
    assert.ok(summary);
    assert.equal(summary.imageId, "img1");
    assert.match(summary.text, /Image base is being rebuilt; only this application restarts when the build finishes/);
    assert.match(summary.text, /The other applications on the image keep the current version/);
    assert.doesNotMatch(summary.text, /SERVER-SUMMARY/);
  });

  it("works without the image name", () => {
    const summary = summarizeImageCommit({ image_build: { image_id: "img1", build_id: "b1" } });
    assert.match(summary?.text ?? "", /^The image is being rebuilt; only this application restarts/);
  });
});

describe("deploy of an app that runs from an image", () => {
  async function deployWith(app: AppEntry["app"], onWarning: (message: string, detail: string) => string | undefined, result: unknown) {
    const infos: Array<{ message: string; items: unknown[] }> = [];
    const warnings: Array<{ message: string; detail: string }> = [];
    win.showQuickPick = async () => "Yes";
    win.showInputBox = async () => "";
    win.showWarningMessage = async (message: unknown, options: unknown) => {
      const detail = (options as { detail?: string })?.detail ?? "";
      warnings.push({ message: String(message), detail });
      return onWarning(String(message), detail) ?? undefined;
    };
    win.showInformationMessage = async (message: unknown, ...items: unknown[]) => {
      infos.push({ message: String(message), items });
      return undefined;
    };
    let deployed = 0;
    deployImplementation = async () => {
      deployed++;
      return result as never;
    };
    const { deps, calls } = fakeDeps(app, (path) => (path === "/v1/images/img1" ? { id: "img1", name: "base", apps: [{}, {}, {}] } : {}));
    registerProjectCommands(deps);
    await vscode.commands.executeCommand("vertraCloud.project.deploy");
    return { infos, warnings, deployed: () => deployed, calls };
  }

  it("warns that the deploy rebuilds the shared image, with how many apps use it, before sending anything", async () => {
    const r = await deployWith(imageApp(), (_m, _d) => "Deploy", {});
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0].message + r.warnings[0].detail, /rebuild/i);
    assert.match(r.warnings[0].detail, /3/);
    assert.match(r.warnings[0].detail, /only this one restarts/i);
    assert.equal(r.deployed(), 1);
  });

  it("sends nothing when the person dismisses the warning", async () => {
    const r = await deployWith(imageApp(), () => undefined, {});
    assert.equal(r.deployed(), 0);
  });

  it("still asks (without the count) when the image can't be read", async () => {
    const infos: unknown[] = [];
    win.showQuickPick = async () => "Yes";
    win.showInputBox = async () => "";
    let detail = "";
    win.showWarningMessage = async (_m: unknown, options: unknown, ...items: unknown[]) => {
      detail = (options as { detail: string }).detail;
      return items[0];
    };
    win.showInformationMessage = async (m: unknown) => infos.push(m);
    deployImplementation = async () => ({}) as never;
    const { deps } = fakeDeps(imageApp(), () => Object.assign(new Error("x"), { code: "API_KEY_SCOPE_DENIED" }));
    registerProjectCommands(deps);
    await vscode.commands.executeCommand("vertraCloud.project.deploy");
    assert.match(detail, /only this one restarts/i);
    assert.doesNotMatch(detail, /\d+ application/);
  });

  it("shows the translated rebuild text with the image name, not the server message, instead of 'Deployed'", async () => {
    const r = await deployWith(imageApp(), (_m, _d) => "Deploy", { image_build: { image_id: "img1", build_id: "b1" }, message: "SERVER-SUMMARY" });
    assert.ok(!r.infos.some((i) => i.message.includes("SERVER-SUMMARY")), "server message must not be shown");
    const done = r.infos.find((i) => /is being rebuilt/.test(i.message));
    assert.ok(done, "expected the rebuild text to be shown");
    assert.match(done.message, /Image base is being rebuilt; only this application restarts/);
    assert.match(done.message, /other applications on the image keep the current version/);
    assert.ok(done.items.some((i) => String(i).includes("Show build log")));
    assert.ok(!r.infos.some((i) => /^Deployed /.test(i.message)));
  });

  it("a regular app deploys exactly as before", async () => {
    const r = await deployWith(regularApp(), () => "unused", {});
    assert.equal(r.warnings.length, 0);
    assert.equal(r.deployed(), 1);
    assert.ok(r.infos.some((i) => /^Deployed /.test(i.message)));
    assert.equal(r.calls.length, 0);
  });
});

describe("publishing an app that runs from an image", () => {
  const publishCall = (calls: Call[]) => calls.find((c) => c.path === "/v1/apps/app-1/network/publish");

  it("asks for the port when the app has none and sends it", async () => {
    let portPrompt: { value?: string } | undefined;
    win.showInputBox = async (options: unknown) => {
      const o = options as { title?: string; prompt?: string; value?: string };
      if ((o.title ?? o.prompt ?? "").includes("Port")) {
        portPrompt = o;
        return "3000";
      }
      return "";
    };
    win.showInformationMessage = async () => undefined;
    const memento = new FakeMemento();
    await memento.update("vertraCloud.images.suggestedPorts", { img1: 8080 });
    const { deps, calls } = fakeDeps(imageApp(), () => ({ subdomain: "x.vertraweb.app", domains: [], type: 2 }), memento);
    registerNetworkCommands(deps);
    await run("vertraCloud.app.publish");
    assert.equal(portPrompt?.value, "8080");
    assert.deepEqual(publishCall(calls)?.opts?.body, { port: 3000 });
  });

  it("does not ask when the app already has a port", async () => {
    const prompts: string[] = [];
    win.showInputBox = async (options: unknown) => {
      prompts.push(JSON.stringify(options));
      return "";
    };
    win.showInformationMessage = async () => undefined;
    const app = imageApp({ custom_image: { id: "x", name: "x", image_id: "img1", version_id: "v1", outdated: false, port: 4000 } });
    const { deps, calls } = fakeDeps(app, () => ({ subdomain: "x.vertraweb.app", domains: [], type: 2 }));
    registerNetworkCommands(deps);
    await run("vertraCloud.app.publish");
    assert.ok(!prompts.some((p) => p.includes("Port")));
    assert.deepEqual(publishCall(calls)?.opts?.body, {});
  });

  it("cancelling the port prompt publishes nothing", async () => {
    win.showInputBox = async (options: unknown) => (JSON.stringify(options).includes("Port") ? undefined : "");
    const { deps, calls } = fakeDeps(imageApp(), () => ({}));
    registerNetworkCommands(deps);
    await run("vertraCloud.app.publish");
    assert.equal(publishCall(calls), undefined);
  });

  it("asks for the port and retries once when the server says IMAGE_APP_PORT_REQUIRED", async () => {
    win.showInputBox = async (options: unknown) => (JSON.stringify(options).includes("Port") ? "5000" : "");
    win.showInformationMessage = async () => undefined;
    let attempts = 0;
    const app = imageApp({ custom_image: { id: "x", name: "x", image_id: "img1", version_id: "v1", outdated: false, port: 9999 } });
    const { deps, calls, errors } = fakeDeps(app, () => {
      attempts++;
      return attempts === 1 ? Object.assign(new Error("x"), { code: "IMAGE_APP_PORT_REQUIRED" }) : { subdomain: "x.vertraweb.app", domains: [], type: 2 };
    });
    registerNetworkCommands(deps);
    await run("vertraCloud.app.publish");
    assert.deepEqual(errors, []);
    const bodies = calls.filter((c) => c.path === "/v1/apps/app-1/network/publish").map((c) => c.opts?.body);
    assert.deepEqual(bodies, [{}, { port: 5000 }]);
  });

  it("a regular app never gets a port prompt", async () => {
    const prompts: string[] = [];
    win.showInputBox = async (options: unknown) => {
      prompts.push(JSON.stringify(options));
      return "";
    };
    win.showInformationMessage = async () => undefined;
    const { deps, calls } = fakeDeps(regularApp(), () => ({ subdomain: "x.vertraweb.app", domains: [], type: 2 }));
    registerNetworkCommands(deps);
    await run("vertraCloud.app.publish");
    assert.ok(!prompts.some((p) => p.includes("Port")));
    assert.deepEqual(publishCall(calls)?.opts?.body, {});
  });
});

describe("snapshot restore of an app that runs from an image", () => {
  const snapshot = { id: "snap1", resource_id: "app-1", author_id: "u", resource_type: 1, size: "10", date: "2026-10-01T10:00:00.000Z", resource_name: "My App" };

  async function restore(app: AppEntry["app"], pickRestoreMode: (items: string[]) => string | undefined, response: unknown) {
    const infos: string[] = [];
    const warnings: string[] = [];
    win.showQuickPick = async (items: unknown) => {
      const list = items as Array<string | { snapshot?: unknown }>;
      const withSnapshot = list.find((i) => typeof i !== "string" && i.snapshot);
      if (withSnapshot) {return withSnapshot;}
      const strings = list as string[];
      if (strings.includes("Restore")) {return "Restore";}
      return pickRestoreMode(strings);
    };
    win.showInformationMessage = async (m: unknown) => infos.push(String(m));
    win.showWarningMessage = async (m: unknown) => warnings.push(String(m));
    const { deps, calls } = fakeDeps(app, (path, opts) => {
      if ((opts?.method ?? "GET") === "GET") {return [snapshot];}
      return response;
    });
    registerSnapshotsCommands(deps);
    await run("vertraCloud.app.manageSnapshots");
    return { calls, infos, warnings, restoreCall: calls.find((c) => c.path.endsWith("/restore")) };
  }

  it("offers 'data only' and 'also go back to the image version'", async () => {
    let offered: string[] = [];
    await restore(imageApp(), (items) => {
      offered = items;
      return undefined;
    }, { message: "ok" });
    assert.equal(offered.length, 2);
    assert.ok(offered.some((o) => /image version/i.test(o)));
  });

  it("sends restore_image_version only when chosen", async () => {
    const withVersion = await restore(imageApp(), (items) => items.find((i) => /image version/i.test(i)), { message: "ok" });
    assert.deepEqual(withVersion.restoreCall?.opts?.body, { restore_image_version: true });
    registeredCommands.clear();
    const dataOnly = await restore(imageApp(), (items) => items.find((i) => !/image version/i.test(i)), { message: "ok" });
    assert.equal(dataOnly.restoreCall?.opts?.body, undefined);
  });

  it("cancelling the choice restores nothing", async () => {
    const r = await restore(imageApp(), () => undefined, { message: "ok" });
    assert.equal(r.restoreCall, undefined);
  });

  it("warns when the recorded image version no longer exists", async () => {
    const r = await restore(imageApp(), (items) => items.find((i) => /image version/i.test(i)), { message: "ok", warning: "IMAGE_VERSION_NOT_FOUND" });
    assert.ok(r.warnings.some((w) => /no longer exists/i.test(w)));
  });

  it("does not warn when the version was restored", async () => {
    const r = await restore(imageApp(), (items) => items.find((i) => /image version/i.test(i)), { message: "ok" });
    assert.equal(r.warnings.length, 0);
  });

  it("a regular app is not asked anything extra", async () => {
    let asked = false;
    const r = await restore(regularApp(), () => {
      asked = true;
      return undefined;
    }, { message: "ok" });
    assert.equal(asked, false);
    assert.ok(r.restoreCall);
    assert.equal(r.restoreCall.opts?.body, undefined);
  });
});

describe("config fields of an app that runs from an image", () => {
  it("does not offer language, version, main, start or build", async () => {
    let offered: string[] = [];
    win.showQuickPick = async (items: unknown) => {
      offered = (items as Array<{ label: string }>).map((i) => i.label);
      return undefined;
    };
    const { deps } = fakeDeps(imageApp({ main_file: "", version: "", start_command: null, build_command: null }), () => ({}));
    registerAppsExtraCommands(deps);
    await run("vertraCloud.app.editConfig");
    assert.deepEqual(offered, ["Name", "Description", "RAM (MB)"]);
  });

  it("a regular app keeps all the fields", async () => {
    let offered: string[] = [];
    win.showQuickPick = async (items: unknown) => {
      offered = (items as Array<{ label: string }>).map((i) => i.label);
      return undefined;
    };
    const { deps } = fakeDeps({ ...regularApp(), main_file: "index.js", version: "recommended", start_command: null, build_command: null } as never, () => ({}));
    registerAppsExtraCommands(deps);
    await run("vertraCloud.app.editConfig");
    assert.equal(offered.length, 7);
  });

  it("vertracloud.config for an image app has no MAIN, VERSION, START or BUILD", () => {
    const text = buildConfigFromApp({
      id: "app-1",
      name: "My App",
      ram: 512,
      main_file: "x.js",
      version: "recommended",
      start_command: "node x",
      build_command: "npm run build",
      subdomain: null,
      custom_image: { image_id: "img1" },
    });
    assert.match(text, /^ID=app-1$/m);
    assert.match(text, /^NAME=My App$/m);
    assert.match(text, /^MEMORY=512$/m);
    for (const key of ["MAIN", "VERSION", "START", "BUILD"]) {assert.doesNotMatch(text, new RegExp(`^${key}=`, "m"));}
  });
});

describe("app tree item of an image app", () => {
  it("flags the context value and describes the runtime as a Docker image", () => {
    const item = appTreeItem({ app: imageApp(), favorite: false });
    assert.match(item.contextValue ?? "", /:image$/);
    assert.match((item.tooltip as { value: string }).value, /Docker image/);
    const regular = appTreeItem({ app: regularApp(), favorite: false });
    assert.doesNotMatch(regular.contextValue ?? "", /:image/);
    assert.match((regular.tooltip as { value: string }).value, /javascript/);
  });
});

