import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import type { APICustomImage } from "@vertracloud/api-types/v1";
import { EventEmitter } from "./vscode-mock";
import { ImagesProvider, type ImageNode } from "../src/views/images";

function image(overrides: Partial<APICustomImage> = {}): APICustomImage {
  return {
    id: "img1",
    name: "web",
    description: null,
    owner: "account",
    status: "success",
    error: null,
    digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    uncompressed_bytes: 1_572_864,
    layer_count: 7,
    suggested_port: null,
    apps: [],
    github: null,
    current_version_id: "ver1",
    created_at: "2026-10-20T10:00:00.000Z",
    updated_at: "2026-10-22T10:00:00.000Z",
    ...overrides,
  };
}

interface Harness {
  provider: ImagesProvider;
  requests: Array<{ path: string; workspaceId: unknown }>;
  workspaces: Array<{ id: string; name: string }>;
  storeEmitter: EventEmitter<void>;
  messages: Array<string | undefined>;
  empties: boolean[];
}

function harness(handler: (workspaceId: string | undefined) => APICustomImage[] | Error, workspaces: Array<{ id: string; name: string }> = []): Harness {
  const requests: Harness["requests"] = [];
  const client = {
    request: async (path: string, opts?: { query?: Record<string, unknown> }) => {
      requests.push({ path, workspaceId: opts?.query?.workspace_id });
      const result = handler(opts?.query?.workspace_id as string | undefined);
      if (result instanceof Error) {throw result;}
      return result;
    },
  };
  const storeEmitter = new EventEmitter<void>();
  const store = { workspaces, onDidChange: storeEmitter.event };
  const provider = new ImagesProvider(() => client as never, store as never);
  const messages: Array<string | undefined> = [];
  const empties: boolean[] = [];
  provider.onMessage = (m) => messages.push(m);
  provider.onEmpty = (e) => empties.push(e);
  return { provider, requests, workspaces, storeEmitter, messages, empties };
}

const apiError = (code: string): Error => Object.assign(new Error(code), { code });

afterEach(() => {
  vi.useRealTimers();
});

describe("ImagesProvider", () => {
  it("lists the account's images with the build status", async () => {
    const h = harness(() => [image(), image({ id: "img2", name: "worker", status: "building" }), image({ id: "img3", name: "broken", status: "failed", error: "RUN failed" })]);
    const nodes = await h.provider.getChildren();
    assert.equal(nodes.length, 3);
    const items = nodes.map((n) => h.provider.getTreeItem(n));
    assert.deepEqual(items.map((i) => i.label), ["web", "worker", "broken"]);
    assert.deepEqual(items.map((i) => i.contextValue?.split(":").slice(0, 2).join(":")), ["image:success", "image:building", "image:failed"]);
    assert.match(String(items[1].description), /Building/);
    assert.match(String(items[2].description), /Failed/);
    assert.equal(h.requests[0].workspaceId, undefined);
  });

  it("flags system images and linked GitHub in the context value", async () => {
    const h = harness(() => [image({ owner: "system" }), image({ id: "i2", github: { repository: "o/r", branch: "main" }, apps: [{ id: "a", name: "a", version_id: "ver1", outdated: false }] })]);
    const [sys, linked] = (await h.provider.getChildren()).map((n) => h.provider.getTreeItem(n));
    assert.match(sys.contextValue ?? "", /:system/);
    assert.doesNotMatch(linked.contextValue ?? "", /:system/);
    assert.match(linked.contextValue ?? "", /:github/);
    assert.match(linked.contextValue ?? "", /:apps/);
  });

  it("shows details as children: status, the failure reason, size, GitHub, apps and id", async () => {
    const failed = image({ status: "failed", error: "The build failed at step 3", github: { repository: "o/r", branch: "main" }, apps: [{ id: "a1", name: "api", version_id: "ver1", outdated: true }] });
    const h = harness(() => [failed]);
    const [root] = await h.provider.getChildren();
    const children = await h.provider.getChildren(root);
    const labels = children.map((c) => String(h.provider.getTreeItem(c).label));
    assert.ok(labels.some((l) => l.startsWith("Status")));
    assert.ok(labels.some((l) => l.includes("The build failed at step 3")));
    assert.ok(labels.some((l) => l.includes("o/r") && l.includes("main")));
    assert.ok(labels.some((l) => l.startsWith("Applications")));
    assert.ok(labels.some((l) => l.startsWith("ID")));
    const appsNode = children.find((c) => c.kind === "imageApps") as ImageNode;
    const appRows = await h.provider.getChildren(appsNode);
    assert.equal(appRows.length, 1);
    const appItem = h.provider.getTreeItem(appRows[0]);
    assert.equal(appItem.label, "api");
    assert.match(String(appItem.description), /newer/i);
  });

  it("shows the description in the tooltip and as an info row, only when there is one", async () => {
    const h = harness(() => [image({ description: "Node 22 with [x](command:workbench.action.reloadWindow)" }), image({ id: "x2" })]);
    const [described, plain] = await h.provider.getChildren();
    const item = h.provider.getTreeItem(described);
    assert.equal(typeof item.tooltip, "string");
    assert.match(String(item.tooltip), /Node 22 with/);
    const rows = async (n: ImageNode) => (await h.provider.getChildren(n)).map((c) => h.provider.getTreeItem(c));
    const described_rows = await rows(described);
    assert.ok(described_rows.some((r) => String(r.label).startsWith("Description")));
    for (const row of described_rows) {assert.notEqual(typeof row.tooltip === "object", true);}
    assert.ok(!(await rows(plain)).some((r) => String(r.label).startsWith("Description")));
    assert.doesNotMatch(String(h.provider.getTreeItem(plain).tooltip), /Description/);
  });

  it("shows size and layers only when the image has a version", async () => {
    const h = harness(() => [image(), image({ id: "x", status: "building", uncompressed_bytes: null, layer_count: null, digest: null, current_version_id: null })]);
    const [ready, building] = await h.provider.getChildren();
    const labelsOf = async (n: ImageNode) => (await h.provider.getChildren(n)).map((c) => String(h.provider.getTreeItem(c).label));
    assert.ok((await labelsOf(ready)).some((l) => l.startsWith("Size")));
    assert.ok(!(await labelsOf(building)).some((l) => l.startsWith("Size")));
  });

  it("never renders image text as markdown (the error comes from the build)", async () => {
    const h = harness(() => [image({ status: "failed", error: "[click](command:workbench.action.reloadWindow)" })]);
    const [root] = await h.provider.getChildren();
    const item = h.provider.getTreeItem(root);
    assert.equal(typeof item.tooltip, "string");
    for (const child of await h.provider.getChildren(root)) {
      assert.notEqual(typeof h.provider.getTreeItem(child).tooltip === "object", true);
    }
  });

  it("reports empty only when there is nothing at all", async () => {
    const empty = harness(() => []);
    await empty.provider.getChildren();
    assert.deepEqual(empty.empties, [true]);
    const withImage = harness(() => [image()]);
    await withImage.provider.getChildren();
    assert.deepEqual(withImage.empties, [false]);
    const withWorkspace = harness(() => [], [{ id: "ws1", name: "Team" }]);
    await withWorkspace.provider.getChildren();
    assert.deepEqual(withWorkspace.empties, [false]);
  });

  it("turns a failed listing into a view message instead of throwing", async () => {
    const h = harness(() => apiError("API_KEY_SCOPE_DENIED"));
    assert.deepEqual(await h.provider.getChildren(), []);
    assert.equal(h.messages.at(-1), "Your API key doesn't have permission for this action.");
    assert.deepEqual(h.empties.at(-1), false);
  });

  it("clears the message after a good load", async () => {
    let fail = true;
    const h = harness(() => (fail ? apiError("NETWORK_ERROR") : [image()]));
    await h.provider.getChildren();
    fail = false;
    await h.provider.getChildren();
    assert.equal(h.messages.at(-1), undefined);
  });

  it("lists a workspace's images lazily, with its workspace_id", async () => {
    const h = harness((ws) => (ws === "ws1" ? [image({ id: "wimg", name: "team-image" })] : [image()]), [{ id: "ws1", name: "Team" }]);
    const root = await h.provider.getChildren();
    assert.deepEqual(root.map((n) => n.kind), ["image", "workspace"]);
    assert.equal(h.requests.length, 1);
    const group = root[1];
    assert.equal(h.provider.getTreeItem(group).label, "Team");
    const inside = await h.provider.getChildren(group);
    assert.equal(inside.length, 1);
    assert.equal(h.requests[1].workspaceId, "ws1");
    assert.equal((inside[0] as { workspaceId?: string }).workspaceId, "ws1");
  });

  it("a workspace without access (or without the feature) just shows no images", async () => {
    const h = harness((ws) => (ws ? apiError("WORKSPACE_PERMISSION_DENIED") : []), [{ id: "ws1", name: "Team" }]);
    const root = await h.provider.getChildren();
    assert.deepEqual(await h.provider.getChildren(root[0]), []);
    assert.equal(h.messages.at(-1), undefined);
  });

  it("re-renders when the set of workspaces changes, not on every store tick", async () => {
    const h = harness(() => [], [{ id: "ws1", name: "Team" }]);
    let fired = 0;
    h.provider.onDidChangeTreeData(() => fired++);
    await h.provider.getChildren();
    h.storeEmitter.fire();
    assert.equal(fired, 0);
    h.workspaces.push({ id: "ws2", name: "Other" });
    h.storeEmitter.fire();
    assert.equal(fired, 1);
  });

  it("keeps refreshing while a build runs and stops when it ends", async () => {
    vi.useFakeTimers();
    let status: APICustomImage["status"] = "building";
    const h = harness(() => [image({ status })]);
    let fired = 0;
    h.provider.onDidChangeTreeData(() => fired++);
    await h.provider.getChildren();
    await vi.advanceTimersByTimeAsync(h.provider.refreshIntervalMs + 10);
    assert.equal(fired, 1);
    status = "success";
    await h.provider.getChildren();
    await vi.advanceTimersByTimeAsync(h.provider.refreshIntervalMs * 3);
    assert.equal(fired, 1);
  });

  it("does not poll while the view is hidden, and resumes when it shows again", async () => {
    vi.useFakeTimers();
    const h = harness(() => [image({ status: "building" })]);
    let fired = 0;
    h.provider.onDidChangeTreeData(() => fired++);
    h.provider.setVisible(false);
    await h.provider.getChildren();
    await vi.advanceTimersByTimeAsync(h.provider.refreshIntervalMs * 3);
    assert.equal(fired, 0);
    h.provider.setVisible(true);
    await vi.advanceTimersByTimeAsync(h.provider.refreshIntervalMs + 10);
    assert.equal(fired >= 1, true);
  });

  it("dispose cancels the pending refresh", async () => {
    vi.useFakeTimers();
    const h = harness(() => [image({ status: "building" })]);
    let fired = 0;
    h.provider.onDidChangeTreeData(() => fired++);
    await h.provider.getChildren();
    h.provider.dispose();
    await vi.advanceTimersByTimeAsync(h.provider.refreshIntervalMs * 3);
    assert.equal(fired, 0);
  });

  it("listAll returns the account's images then each workspace's, tolerating failures", async () => {
    const h = harness((ws) => (ws === "bad" ? apiError("WORKSPACE_PERMISSION_DENIED") : ws ? [image({ id: "w", name: "w-img" })] : [image()]), [
      { id: "ws1", name: "Team" },
      { id: "bad", name: "Locked" },
    ]);
    const all = await h.provider.listAll();
    assert.deepEqual(all.map((r) => [r.image.id, r.workspaceId]), [["img1", undefined], ["w", "ws1"]]);
  });
});
