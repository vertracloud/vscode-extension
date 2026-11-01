import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as vscode from "vscode";
import { FakeMemento, registeredCommands, Uri } from "./vscode-mock";
import { getPlansCatalog, resetPlansCache } from "../src/api/plans";
import { findDockerfileRoot, planAllowsImages } from "../src/images/dockerfile";
import { registerProjectCommands } from "../src/commands/project";
import type { CommandDeps } from "../src/commands/deps";

const created: string[] = [];
const createAppFromFolder = vi.fn(async () => ({ id: "new-app", name: "demo", status: "up" }));
vi.mock("../src/deploy/deploy", () => ({
  deployToApp: async () => ({}),
  createAppFromFolder: (...args: unknown[]) => (createAppFromFolder as unknown as (...a: unknown[]) => unknown)(...args),
}));

const win = vscode.window as unknown as Record<string, (...args: unknown[]) => unknown>;
const original = { ...win };

async function makeFolder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vertra-shortcut-"));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return root;
}

const CONFIG = "NAME=demo\nMAIN=index.js\nMEMORY=256\nVERSION=recommended\n";

function fakeDeps(planName: string | undefined): CommandDeps {
  return {
    client: { request: async (path: string) => (path === "/v1/plans" ? catalog : {}) },
    showError: (err: unknown) => {
      throw err;
    },
    refresh: async () => {},
    context: { subscriptions: [], workspaceState: new FakeMemento() },
    store: { apps: [], user: planName ? { plan: { name: planName } } : { plan: null }, pollAfterMutation: async () => {} },
    links: { links: [], refresh: async () => {} },
  } as unknown as CommandDeps;
}

async function deployFolder(root: string, planName: string | undefined, answer: "image" | "app" | undefined) {
  const prompts: Array<{ message: string; items: string[] }> = [];
  const imageCalls: unknown[][] = [];
  registeredCommands.set("vertraCloud.images.create", (...args: unknown[]) => {
    imageCalls.push(args);
  });
  win.showOpenDialog = async () => [Uri.file(root)];
  win.showQuickPick = async (items: unknown) => (items as string[])[0];
  win.showInputBox = async () => "";
  win.showErrorMessage = async () => undefined;
  win.showInformationMessage = async (message: unknown, ...rest: unknown[]) => {
    const items = rest.filter((r): r is string => typeof r === "string");
    prompts.push({ message: String(message), items });
    if (!items.some((i) => /Docker image/i.test(i))) {return undefined;}
    if (answer === "image") {return items.find((i) => /Docker image/i.test(i));}
    if (answer === "app") {return items.find((i) => !/Docker image/i.test(i));}
    return undefined;
  };
  registerProjectCommands(fakeDeps(planName));
  await vscode.commands.executeCommand("vertraCloud.project.deployFolder");
  return { prompts, imageCalls };
}

beforeEach(() => {
  resetPlansCache();
  registeredCommands.clear();
  createAppFromFolder.mockClear();
});

afterEach(async () => {
  Object.assign(win, original);
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const limits = (max_custom_images: number) => ({ max_custom_images });
const catalog = {
  grid: "v3",
  cycles: [],
  plans: [
    { name: "starter-2", limits: limits(0) },
    { name: "pro-2", limits: limits(2) },
    { name: "business-6", limits: limits(6) },
    { name: "enterprise-20", limits: limits(20) },
  ],
} as never;

describe("planAllowsImages", () => {
  it("follows max_custom_images in the catalog, not a list of plan names", async () => {
    const load = async () => catalog;
    for (const name of ["pro-2", "business-6", "enterprise-20"]) {assert.equal(await planAllowsImages({ plan: { name } } as never, load), true, name);}
    assert.equal(await planAllowsImages({ plan: { name: "starter-2" } } as never, load), false);
  });

  it("is false without a plan or user, and does not even load the catalog", async () => {
    const load = vi.fn(async () => catalog);
    assert.equal(await planAllowsImages({ plan: null } as never, load), false);
    assert.equal(await planAllowsImages(undefined, load), false);
    assert.equal(load.mock.calls.length, 0);
  });

  it("leaves the decision to the api when the route fails or does not know the plan", async () => {
    const fail = async () => {
      throw new Error("offline");
    };
    assert.equal(await planAllowsImages({ plan: { name: "pro-2" } } as never, fail), true);
    assert.equal(await planAllowsImages({ plan: { name: "old-plan" } } as never, async () => catalog), true);
  });
});

describe("getPlansCatalog", () => {
  it("reads the public route once per session and retries after a failure", async () => {
    resetPlansCache();
    const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(catalog);
    const client = { request } as never;
    await assert.rejects(getPlansCatalog(client));
    assert.equal(await getPlansCatalog(client), catalog);
    assert.equal(await getPlansCatalog(client), catalog);
    assert.equal(request.mock.calls.length, 2);
    assert.deepEqual(request.mock.calls[0], ["/v1/plans", { anonymous: true }]);
    resetPlansCache();
  });
});

describe("findDockerfileRoot", () => {
  it("finds a Dockerfile at the root", async () => {
    const root = await makeFolder({ Dockerfile: "FROM scratch\n" });
    assert.equal(await findDockerfileRoot(root), root);
  });

  it("finds it in a single root folder, as the website does for a zip", async () => {
    const root = await makeFolder({ "project/Dockerfile": "FROM scratch\n", "project/app.js": "x" });
    assert.equal(await findDockerfileRoot(root), path.join(root, "project"));
  });

  it("ignores other spellings, a directory with that name and several root entries", async () => {
    assert.equal(await findDockerfileRoot(await makeFolder({ "dockerfile.dev": "x", "Dockerfile.prod": "x" })), undefined);
    assert.equal(await findDockerfileRoot(await makeFolder({ "Dockerfile/readme": "x" })), undefined);
    assert.equal(await findDockerfileRoot(await makeFolder({ "a/Dockerfile": "x", "b/x": "x" })), undefined);
    assert.equal(await findDockerfileRoot(path.join(tmpdir(), "vertra-does-not-exist-xyz")), undefined);
  });
});

describe("deploy of a new app from a folder with a Dockerfile", () => {
  it("offers the Docker image on a plan with images and opens the image flow with that folder when accepted", async () => {
    const root = await makeFolder({ Dockerfile: "FROM scratch\n", "vertracloud.config": CONFIG });
    const r = await deployFolder(root, "enterprise-20", "image");
    assert.equal(r.prompts.filter((p) => p.items.some((i) => /Docker image/i.test(i))).length, 1);
    assert.equal(r.imageCalls.length, 1);
    const arg = r.imageCalls[0][0] as { fsPath: string };
    assert.equal(arg.fsPath, root);
    assert.equal(createAppFromFolder.mock.calls.length, 0);
  });

  it("passes the single root folder, not the parent, to the image flow", async () => {
    const root = await makeFolder({ "proj/Dockerfile": "FROM scratch\n", "vertracloud.config": CONFIG });
    // two root entries: not a single root folder, so nothing is offered
    const r = await deployFolder(root, "enterprise-20", "image");
    assert.equal(r.imageCalls.length, 0);
    const only = await makeFolder({ "proj/Dockerfile": "FROM scratch\n" });
    const r2 = await deployFolder(only, "enterprise-20", "image");
    assert.equal((r2.imageCalls[0][0] as { fsPath: string }).fsPath, path.join(only, "proj"));
  });

  it("keeps the regular application flow when the offer is declined", async () => {
    const root = await makeFolder({ Dockerfile: "FROM scratch\n", "vertracloud.config": CONFIG });
    const r = await deployFolder(root, "business-6", "app");
    assert.equal(r.prompts.length >= 1, true);
    assert.equal(r.imageCalls.length, 0);
    assert.equal(createAppFromFolder.mock.calls.length, 1);
  });

  it("does not offer anything without a Dockerfile", async () => {
    const root = await makeFolder({ "index.js": "x", "vertracloud.config": CONFIG });
    const r = await deployFolder(root, "pro-2", "image");
    assert.ok(!r.prompts.some((p) => p.items.some((i) => /Docker image/i.test(i))));
    assert.equal(r.imageCalls.length, 0);
    assert.equal(createAppFromFolder.mock.calls.length, 1);
  });

  it("does not offer anything when the plan has no images or the plan is unknown", async () => {
    for (const plan of ["starter-2", undefined]) {
      registeredCommands.clear();
      createAppFromFolder.mockClear();
      const root = await makeFolder({ Dockerfile: "FROM scratch\n", "vertracloud.config": CONFIG });
      const r = await deployFolder(root, plan, "image");
      assert.ok(!r.prompts.some((p) => p.items.some((i) => /Docker image/i.test(i))), String(plan));
      assert.equal(r.imageCalls.length, 0);
      assert.equal(createAppFromFolder.mock.calls.length, 1);
    }
  });
});
