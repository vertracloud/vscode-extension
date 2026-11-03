import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import * as vscodeMock from "./vscode-mock";
import { formatErrors, formatPerformance, formatRequests, formatTraffic, registerAnalyticsCommands, safeText } from "../src/commands/analytics";
import { describeError } from "../src/l10n";
import type { CommandDeps } from "../src/commands/deps";
import type {
  APIApplicationAnalyticsErrors,
  APIApplicationAnalyticsPerformance,
  APIApplicationAnalyticsRequestList,
  APIApplicationAnalyticsTraffic,
} from "@vertracloud/api-types/v1";

const meta = {
  start: "2026-11-01T00:00:00.000Z",
  end: "2026-11-02T00:00:00.000Z",
  hosts: ["demo.vertraweb.app"],
  web_published: true,
  sampled: false,
  stale: false,
  generated_at: "2026-11-02T00:01:00.000Z",
  history_days: 7,
};

const summary = { requests: 1200, visits: 300, bytes: 2_048_000, errors_4xx: 12, errors_5xx: 3, error_rate_4xx: 0.01, error_rate_5xx: 0.0025, edge_time_p95_ms: 182.4 };

const traffic: APIApplicationAnalyticsTraffic = {
  ...meta,
  interval: "1h",
  summary,
  series: [],
  previous: { start: meta.start, end: meta.end, summary: { ...summary, requests: 600 }, series: [] },
  breakdowns: {
    country: [{ value: "BR", label: null, requests: 900, visits: 200, bytes: 10 }],
    path: [{ value: "/x\u001b[2J\nINJECT", label: null, requests: 5, visits: 1, bytes: 1 }],
    asn: [{ value: "28573", label: "Claro", requests: 4, visits: 1, bytes: 1 }],
  },
};

test("safeText troca controle e escape por ?", () => {
  assert.equal(safeText("a\u001b[2Jb\nc‮d"), "a?[2Jb?c?d");
});

test("formatTraffic mostra resumo, comparação e o top por dimensão sem controle vindo do visitante", () => {
  const text = formatTraffic(traffic, "my-app");
  for (const want of ["my-app", "1,200", "+100.0%", "BR", "28573 (Claro)", "Countries", "Networks (ASN)"]) {
    assert.ok(text.includes(want), `faltou ${want}\n${text}`);
  }
  assert.ok(!/[\u001b]/.test(text) && !text.includes("\nINJECT"), "controle do visitante vazou");
});

test("formatTraffic limita cada dimensão a 10 linhas", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ value: `/p${i}`, label: null, requests: 100 - i, visits: 1, bytes: 1 }));
  const text = formatTraffic({ ...traffic, previous: null, breakdowns: { path: many } }, "a");
  assert.ok(text.includes("/p9") && !text.includes("/p10"));
});

test("sem site publicado e sem tráfego são estados explícitos", () => {
  const empty = { ...traffic, summary: null, previous: null, breakdowns: {} };
  assert.ok(formatTraffic({ ...empty, web_published: false, hosts: [] }, "a").includes("no site published"));
  assert.ok(formatTraffic(empty, "a").includes("No requests in the window."));
});

test("formatErrors conta só 5xx por padrão e lista status e rotas", () => {
  const data: APIApplicationAnalyticsErrors = {
    ...meta,
    interval: "1h",
    include_4xx: false,
    summary: { requests: 100, errors: 3, error_rate: 0.03, errors_4xx: 9, errors_5xx: 3 },
    series: [],
    previous: null,
    paths: [{ value: "/api", requests: 50, errors: 3, error_rate: 0.06 }],
    statuses: [{ value: "502", label: null, requests: 3, visits: 0, bytes: 0 }],
  };
  const text = formatErrors(data, "a");
  for (const want of ["Counting 5xx only.", "502", "/api", "6.00%"]) {assert.ok(text.includes(want), want);}
});

test("formatPerformance mostra borda e container em p50 a p99.9", () => {
  const l = { avg_ms: 40, p50_ms: 30, p75_ms: 50, p90_ms: 80, p95_ms: 120, p99_ms: 300, p999_ms: 900 };
  const data: APIApplicationAnalyticsPerformance = {
    ...meta,
    interval: "1h",
    summary: { requests: 50, edge: l, container: { ...l, p999_ms: 400 } },
    series: [],
    previous: null,
    countries: [],
    edge_locations: [{ value: "GRU", label: null, requests: 50, edge: { avg_ms: 1, p50_ms: 1, p95_ms: 2, p99_ms: 3 }, container: null }],
    slow_paths: [],
    path_issues: [],
  };
  const text = formatPerformance(data, "a");
  for (const want of ["p99.9", "900 ms", "400 ms", "GRU"]) {assert.ok(text.includes(want), want);}
});

test("formatRequests mostra request_id e trata a linha como texto", () => {
  const data: APIApplicationAnalyticsRequestList = {
    ...meta,
    order: "desc",
    cursor: null,
    requests: [{
      time: "2026-11-01T10:00:00.000Z", request_id: "ray-1", host: "h", path: "/a\u001b[31m", query: "x=1", method: "GET", protocol: "HTTP/2",
      status: 502, container_status: null, edge_time_ms: 12.5, container_time_ms: null, ip: "1.2.3.4", asn: 1, asn_name: "n", country: "BR",
      edge_location: "GRU", referer: "(none)", referer_url: null, device: "desktop", os: "x", browser: "y", bot: "(none)", content_type: "html", cache_status: "miss",
    }],
  };
  const text = formatRequests(data, "a");
  assert.ok(text.includes("ray-1") && text.includes("502") && text.includes("/a?[31m?x=1"));
  assert.ok(!text.includes("\u001b"));
});

test("describeError traduz os erros de plano, janela e ocupado sem ecoar o servidor", () => {
  for (const code of ["PLAN_DOES_NOT_SUPPORT_WEB_ANALYTICS_PERFORMANCE", "PLAN_DOES_NOT_SUPPORT_WEB_ANALYTICS_REQUESTS", "ANALYTICS_RANGE_EXCEEDS_PLAN", "ANALYTICS_BUSY", "INVALID_RANGE"]) {
    const text = describeError({ code, message: "RAW-SERVER-TEXT" });
    assert.ok(text.length > 0 && !text.includes("RAW-SERVER-TEXT") && !text.includes(code), code);
  }
  const range = describeError({ code: "ANALYTICS_RANGE_EXCEEDS_PLAN", details: { history_days: 7, earliest: "2026-10-27T00:00:00.000Z" } });
  assert.ok(range.includes("7") && range.includes("2026-10-27"));
  assert.ok(describeError({ code: "ANALYTICS_BUSY", retryAfter: 60 }).includes("1 min"));
});

// --- comandos ---

interface Call { path: string; query?: Record<string, unknown> }
let calls: Call[];
let errors: unknown[];
let replies: Record<string, unknown>;

function makeDeps(): CommandDeps {
  calls = [];
  errors = [];
  return {
    context: { subscriptions: [] },
    client: {
      request: async (path: string, opts?: { query?: Record<string, unknown> }) => {
        calls.push({ path, query: opts?.query });
        const reply = replies[path];
        if (reply instanceof Error) {throw reply;}
        return reply;
      },
    },
    showError: (err: unknown) => void errors.push(err),
    resolveApp: async () => ({ app: { id: "app1", name: "my-app" } }),
  } as unknown as CommandDeps;
}

beforeEach(() => {
  replies = {};
  vscodeMock.openedTextDocuments.length = 0;
  vscodeMock.window.showQuickPick = (async (items: unknown[]) => items[0]) as unknown as typeof vscodeMock.window.showQuickPick;
});

async function exec(command: string): Promise<void> {
  const handler = vscodeMock.registeredCommands.get(command);
  assert.ok(handler, `${command} não registrado`);
  await handler!(undefined);
}

test("os 5 comandos de analytics são registrados", () => {
  registerAnalyticsCommands(makeDeps());
  for (const id of ["", ".summary", ".performance", ".errors", ".requests"]) {
    assert.ok(vscodeMock.registeredCommands.has(`vertraCloud.app.analytics${id}`), id);
  }
});

test("Analytics: resumo pede a janela (24 h) com compare e abre o texto", async () => {
  replies["/v1/apps/app1/analytics"] = traffic;
  registerAnalyticsCommands(makeDeps());
  await exec("vertraCloud.app.analytics.summary");
  assert.equal(calls.length, 1);
  const q = calls[0]!.query!;
  assert.equal(q.compare, true);
  assert.equal(new Date(String(q.end)).getTime() - new Date(String(q.start)).getTime(), 24 * 3_600_000);
  assert.equal(vscodeMock.openedTextDocuments.length, 1);
  assert.ok(vscodeMock.openedTextDocuments[0]!.content?.includes("my-app"));
});

test("o comando Analytics… escolhe a visão pelo quick pick", async () => {
  replies["/v1/apps/app1/analytics/errors"] = { ...meta, interval: "1h", include_4xx: false, summary: null, series: [], previous: null, paths: [], statuses: [] };
  let n = 0;
  vscodeMock.window.showQuickPick = (async (items: Array<{ view?: string }>) => (n++ === 0 ? items.find((i) => i.view === "errors") : items[0])) as unknown as typeof vscodeMock.window.showQuickPick;
  registerAnalyticsCommands(makeDeps());
  await exec("vertraCloud.app.analytics");
  assert.equal(calls[0]!.path, "/v1/apps/app1/analytics/errors");
});

test("Analytics: requisições pede 50 mais novas e usa o cursor na próxima página", async () => {
  const page = (cursor: string | null) => ({ ...meta, order: "desc", cursor, requests: [] });
  let call = 0;
  const deps = makeDeps();
  (deps.client as unknown as { request: unknown }).request = async (path: string, opts?: { query?: Record<string, unknown> }) => {
    calls.push({ path, query: opts?.query });
    return call++ === 0 ? page("c1") : page(null);
  };
  vscodeMock.window.showInformationMessage = (async (_m: string, ...actions: string[]) => actions[0]) as unknown as typeof vscodeMock.window.showInformationMessage;
  registerAnalyticsCommands(deps);
  await exec("vertraCloud.app.analytics.requests");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.query!.limit, 50);
  assert.equal(calls[0]!.query!.order, "desc");
  assert.equal(calls[0]!.query!.cursor, undefined);
  assert.equal(calls[1]!.query!.cursor, "c1");
  assert.equal(calls[1]!.query!.start, calls[0]!.query!.start);
});

test("erro da API vai para showError", async () => {
  replies["/v1/apps/app1/analytics/performance"] = Object.assign(new Error("x"), { code: "PLAN_DOES_NOT_SUPPORT_WEB_ANALYTICS_PERFORMANCE" });
  registerAnalyticsCommands(makeDeps());
  await exec("vertraCloud.app.analytics.performance");
  assert.equal(errors.length, 1);
  assert.equal(vscodeMock.openedTextDocuments.length, 0);
});
