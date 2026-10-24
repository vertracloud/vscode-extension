import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as vscode from "vscode";
import { FakeMemento, registeredCommands, Uri } from "./vscode-mock";
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
    client: { request: async () => ({}) },
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
  registeredCommands.clear();
  createAppFromFolder.mockClear();
});

afterEach(async () => {
  Object.assign(win, original);
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("planAllowsImages", () => {
  it("is true only for the Enterprise tiers that can build images", () => {
    for (const name of ["enterprise-28", "enterprise-30", "enterprise-32"]) {assert.equal(planAllowsImages({ plan: { name } } as never), true, name);}
    for (const name of ["economy", "pro-8", "enterprise-26"]) {assert.equal(planAllowsImages({ plan: { name } } as never), false, name);}
    assert.equal(planAllowsImages({ plan: null } as never), false);
    assert.equal(planAllowsImages(undefined), false);
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
    const r = await deployFolder(root, "enterprise-28", "image");
    assert.equal(r.prompts.filter((p) => p.items.some((i) => /Docker image/i.test(i))).length, 1);
    assert.equal(r.imageCalls.length, 1);
    const arg = r.imageCalls[0][0] as { fsPath: string };
    assert.equal(arg.fsPath, root);
    assert.equal(createAppFromFolder.mock.calls.length, 0);
  });

  it("passes the single root folder, not the parent, to the image flow", async () => {
    const root = await makeFolder({ "proj/Dockerfile": "FROM scratch\n", "vertracloud.config": CONFIG });
    // two root entries: not a single root folder, so nothing is offered
    const r = await deployFolder(root, "enterprise-28", "image");
    assert.equal(r.imageCalls.length, 0);
    const only = await makeFolder({ "proj/Dockerfile": "FROM scratch\n" });
    const r2 = await deployFolder(only, "enterprise-28", "image");
    assert.equal((r2.imageCalls[0][0] as { fsPath: string }).fsPath, path.join(only, "proj"));
  });

  it("keeps the regular application flow when the offer is declined", async () => {
    const root = await makeFolder({ Dockerfile: "FROM scratch\n", "vertracloud.config": CONFIG });
    const r = await deployFolder(root, "enterprise-30", "app");
    assert.equal(r.prompts.length >= 1, true);
    assert.equal(r.imageCalls.length, 0);
    assert.equal(createAppFromFolder.mock.calls.length, 1);
  });

  it("does not offer anything without a Dockerfile", async () => {
    const root = await makeFolder({ "index.js": "x", "vertracloud.config": CONFIG });
    const r = await deployFolder(root, "enterprise-32", "image");
    assert.ok(!r.prompts.some((p) => p.items.some((i) => /Docker image/i.test(i))));
    assert.equal(r.imageCalls.length, 0);
    assert.equal(createAppFromFolder.mock.calls.length, 1);
  });

  it("does not offer anything when the plan has no images or the plan is unknown", async () => {
    for (const plan of ["pro-8", undefined]) {
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
