import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  buildImageAppBody,
  buildImageForm,
  checkDockerfile,
  createAppFromImage,
  createImage,
  deleteImage,
  getImageContext,
  linkImageGithub,
  listImages,
  listImageVersions,
  openImageLogStream,
  rebuildImage,
  unlinkImageGithub,
  updateImage,
} from "../src/api/images";
import { PortHints, chooseImagePort, parsePort } from "../src/images/ports";

interface Call {
  path: string;
  opts: {
    method?: string;
    query?: Record<string, unknown>;
    body?: unknown;
    form?: FormData;
    timeoutMs?: number;
  };
}

function fakeClient(result: unknown = {}): { client: never; calls: Call[]; streams: Array<{ path: string; opts: { query?: Record<string, unknown> } }> } {
  const calls: Call[] = [];
  const streams: Array<{ path: string; opts: { query?: Record<string, unknown> } }> = [];
  const client = {
    request: async (path: string, opts: Call["opts"] = {}) => {
      calls.push({ path, opts });
      return result;
    },
    stream: async (path: string, opts: { query?: Record<string, unknown> }) => {
      streams.push({ path, opts });
      return new ReadableStream<Uint8Array>();
    },
  } as never;
  return { client, calls, streams };
}

describe("image routes", () => {
  it("lists, scoped by workspace_id only when given", async () => {
    const a = fakeClient([]);
    await listImages(a.client);
    assert.equal(a.calls[0].path, "/v1/images");
    assert.equal(a.calls[0].opts.query?.workspace_id, undefined);
    const b = fakeClient([]);
    await listImages(b.client, { workspaceId: "ws1" });
    assert.equal(b.calls[0].opts.query?.workspace_id, "ws1");
  });

  it("encodes the image id in the path", async () => {
    const { client, calls } = fakeClient([]);
    await listImageVersions(client, "a/b c", { workspaceId: "w" });
    assert.equal(calls[0].path, "/v1/images/a%2Fb%20c/versions");
  });

  it("creates with a multipart form and a long timeout", async () => {
    const { client, calls } = fakeClient({});
    const form = new FormData();
    await createImage(client, form);
    assert.equal(calls[0].path, "/v1/images");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.form, form);
    assert.ok((calls[0].opts.timeoutMs ?? 0) >= 5 * 60_000);
  });

  it("rebuilds with PUT, the form and the workspace in the query", async () => {
    const { client, calls } = fakeClient({});
    const form = new FormData();
    await rebuildImage(client, "img1", form, { workspaceId: "ws1" });
    assert.equal(calls[0].path, "/v1/images/img1");
    assert.equal(calls[0].opts.method, "PUT");
    assert.equal(calls[0].opts.form, form);
    assert.equal(calls[0].opts.query?.workspace_id, "ws1");
  });

  it("updates with PATCH, only the given fields and the workspace in the query", async () => {
    const { client, calls } = fakeClient({});
    await updateImage(client, "a/b", { name: "api-v2", description: null }, { workspaceId: "ws1" });
    assert.equal(calls[0].path, "/v1/images/a%2Fb");
    assert.equal(calls[0].opts.method, "PATCH");
    assert.deepEqual(calls[0].opts.body, { name: "api-v2", description: null });
    assert.equal(calls[0].opts.query?.workspace_id, "ws1");
  });

  it("deletes sending confirm_name in the body", async () => {
    const { client, calls } = fakeClient({ deleted_apps: [] });
    await deleteImage(client, "img1", "my-image", { workspaceId: "ws1" });
    assert.equal(calls[0].opts.method, "DELETE");
    assert.deepEqual(calls[0].opts.body, { confirm_name: "my-image" });
    assert.equal(calls[0].opts.query?.workspace_id, "ws1");
  });

  it("links and unlinks GitHub", async () => {
    const { client, calls } = fakeClient({});
    await linkImageGithub(client, "img1", { repository: "o/r", branch: "main" });
    await unlinkImageGithub(client, "img1", { workspaceId: "w" });
    assert.equal(calls[0].path, "/v1/images/img1/github");
    assert.equal(calls[0].opts.method, "PUT");
    assert.deepEqual(calls[0].opts.body, { repository: "o/r", branch: "main" });
    assert.equal(calls[1].opts.method, "DELETE");
    assert.equal(calls[1].opts.query?.workspace_id, "w");
  });

  it("checks a Dockerfile with a JSON body", async () => {
    const { client, calls } = fakeClient({ refusals: [], warnings: [], suggested_port: 80 });
    await checkDockerfile(client, { dockerfile: "FROM scratch", files: ["Dockerfile"] });
    assert.equal(calls[0].path, "/v1/images/check");
    assert.equal(calls[0].opts.method, "POST");
    assert.deepEqual(calls[0].opts.body, { dockerfile: "FROM scratch", files: ["Dockerfile"] });
  });

  it("gets the context download URL", async () => {
    const { client, calls } = fakeClient({ url: "https://x" });
    await getImageContext(client, "img1", { workspaceId: "w" });
    assert.equal(calls[0].path, "/v1/images/img1/context");
    assert.equal(calls[0].opts.query?.workspace_id, "w");
  });

  it("creates the app on /v1/apps/image", async () => {
    const { client, calls } = fakeClient({});
    await createAppFromImage(client, { image_id: "i", name: "n", memory: 512, web: false });
    assert.equal(calls[0].path, "/v1/apps/image");
    assert.equal(calls[0].opts.method, "POST");
  });

  it("opens the log stream with the version and workspace", async () => {
    const { client, streams } = fakeClient();
    const controller = new AbortController();
    await openImageLogStream(client, "img1", { versionId: "v1", workspaceId: "w", signal: controller.signal });
    assert.equal(streams[0].path, "/v1/images/img1/logs");
    assert.equal(streams[0].opts.query?.version_id, "v1");
    assert.equal(streams[0].opts.query?.workspace_id, "w");
  });
});

describe("buildImageForm", () => {
  it("sends a file source with the name, workspace and the zip as a file part", async () => {
    const form = buildImageForm({ name: "web", workspaceId: "ws1", file: { bytes: new Uint8Array([1, 2, 3]), filename: "ctx.zip" } });
    assert.equal(form.get("name"), "web");
    assert.equal(form.get("workspace_id"), "ws1");
    const file = form.get("file") as File;
    assert.equal(file.name, "ctx.zip");
    assert.equal(file.size, 3);
    assert.equal(form.get("github_repository"), null);
  });

  it("sends a GitHub source with repository and branch and no file", () => {
    const form = buildImageForm({ name: "web", github: { repository: "o/r", branch: "main" } });
    assert.equal(form.get("github_repository"), "o/r");
    assert.equal(form.get("github_branch"), "main");
    assert.equal(form.get("file"), null);
    assert.equal(form.get("workspace_id"), null);
  });

  it("sends a GitHub source without a branch when none is given", () => {
    const form = buildImageForm({ name: "web", github: { repository: "o/r" } });
    assert.equal(form.get("github_repository"), "o/r");
    assert.equal(form.has("github_branch"), false);
  });

  it("omits the name on a rebuild (the image already has one)", () => {
    const form = buildImageForm({ file: { bytes: new Uint8Array([1]), filename: "c.zip" } });
    assert.equal(form.get("name"), null);
    assert.ok(form.get("file"));
  });

  it("refuses both sources or none", () => {
    assert.throws(() => buildImageForm({ name: "x" }));
    assert.throws(() =>
      buildImageForm({ name: "x", file: { bytes: new Uint8Array(), filename: "a.zip" }, github: { repository: "o/r", branch: "b" } }),
    );
  });
});

describe("buildImageAppBody", () => {
  const base = { imageId: "img1", name: "api", memory: 512 };

  it("a web app sends the subdomain (random when empty) and the port", () => {
    assert.deepEqual(buildImageAppBody({ ...base, web: true, subdomain: "", port: 3000, envs: [] }), {
      image_id: "img1",
      name: "api",
      memory: 512,
      web: true,
      subdomain: "random",
      port: 3000,
    });
    const named = buildImageAppBody({ ...base, web: true, subdomain: "my-api", port: 80, envs: [] });
    assert.equal(named.subdomain, "my-api");
  });

  it("an app without web never sends subdomain or port", () => {
    const body = buildImageAppBody({ ...base, web: false, subdomain: "x", port: 8080, envs: [] });
    assert.equal(body.web, false);
    assert.ok(!("subdomain" in body));
    assert.ok(!("port" in body));
  });

  it("includes envs, the workspace and a description only when present", () => {
    const body = buildImageAppBody({ ...base, web: false, envs: [{ key: "A", value: "1" }], workspaceId: "w", description: "  hi  " });
    assert.deepEqual(body.envs, [{ key: "A", value: "1" }]);
    assert.equal(body.workspace_id, "w");
    assert.equal(body.description, "hi");
    const plain = buildImageAppBody({ ...base, web: false, envs: [] });
    assert.ok(!("envs" in plain));
    assert.ok(!("workspace_id" in plain));
    assert.ok(!("description" in plain));
  });
});

describe("ports", () => {
  it("parsePort accepts 1-65535 integers only", () => {
    assert.equal(parsePort("3000"), 3000);
    assert.equal(parsePort(" 80 "), 80);
    for (const bad of ["", "0", "65536", "1.5", "abc", "-1", "80a"]) {assert.equal(parsePort(bad), undefined, bad);}
  });

  it("chooseImagePort prefers the app's own port, then the hint of the check, then 80", () => {
    assert.equal(chooseImagePort({ current: 4000, hint: 3000 }), 4000);
    assert.equal(chooseImagePort({ current: null, hint: 3000 }), 3000);
    assert.equal(chooseImagePort({ current: null, hint: undefined }), 80);
    assert.equal(chooseImagePort({ hint: 0 }), 80);
  });

  it("chooseImagePort uses the API's suggested_port before the local hint, and skips a null one", () => {
    assert.equal(chooseImagePort({ current: null, api: 4000, hint: 3000 }), 4000);
    assert.equal(chooseImagePort({ current: null, api: null, hint: 3000 }), 3000);
    assert.equal(chooseImagePort({ current: null, api: null, hint: undefined }), 80);
    assert.equal(chooseImagePort({ current: 5000, api: 4000, hint: 3000 }), 5000);
  });

  it("PortHints remembers the suggested port per image across instances", async () => {
    const store = new Map<string, unknown>();
    const memento = {
      get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      keys: () => [...store.keys()],
    };
    const hints = new PortHints(memento as never);
    assert.equal(hints.get("img1"), undefined);
    await hints.set("img1", 3000);
    assert.equal(new PortHints(memento as never).get("img1"), 3000);
    await hints.set("img1", 99999);
    assert.equal(hints.get("img1"), 3000);
  });
});
