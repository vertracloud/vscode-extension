import * as vscode from "vscode";
import type {
  APIApplicationAnalyticsErrors,
  APIApplicationAnalyticsMeta,
  APIApplicationAnalyticsPerformance,
  APIApplicationAnalyticsRequestList,
  APIApplicationAnalyticsTraffic,
  ApplicationAnalyticsDimension,
} from "@vertracloud/api-types/v1";
import {
  type AnalyticsWindow,
  getAnalytics,
  getAnalyticsErrors,
  getAnalyticsPerformance,
  listAnalyticsRequests,
} from "../api/analytics";
import type { CommandDeps } from "./deps";

const TOP = 10;
const HOUR = 3_600_000;

type View = "summary" | "performance" | "errors" | "requests";

interface App {
  id: string;
  name: string;
}

/** Tudo abaixo que vem do visitante (rota, origem, rede) vira texto puro: sem controle nem escape. */
export function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "?");
}

function int(n: number): string {
  return new Intl.NumberFormat(vscode.env.language).format(n);
}

function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(1)} ${units[i]}`;
}

function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) {return "-";}
  if (v >= 10_000) {return `${(v / 1000).toFixed(1)} s`;}
  return v >= 100 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`;
}

function pct(rate: number): string {
  const p = rate * 100;
  return p > 0 && p < 0.01 ? "<0.01%" : `${p.toFixed(2)}%`;
}

function change(current: number, previous: number): string {
  if (previous === 0) {return current === 0 ? "=" : vscode.l10n.t("new");}
  const d = ((current - previous) / previous) * 100;
  return Math.abs(d) < 0.05 ? "=" : `${d > 0 ? "+" : ""}${d.toFixed(1)}%`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function table(head: string[], rows: string[][], right: number[] = []): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    "  " + cells.map((c, i) => (right.includes(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(head), ...rows.map(line)];
}

function sparkline(values: number[]): string {
  const blocks = "▁▂▃▄▅▆▇█";
  const max = Math.max(0, ...values);
  return values.map((v) => blocks[max === 0 ? 0 : Math.floor((v / max) * (blocks.length - 1))]).join("");
}

function when(iso: string): string {
  return new Intl.DateTimeFormat(vscode.env.language, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

function header(title: string, appName: string, meta: APIApplicationAnalyticsMeta, interval?: string): string[] {
  const out = [`${title} — ${safeText(appName)}`, "", `${vscode.l10n.t("Window")}: ${when(meta.start)} → ${when(meta.end)}${interval ? ` (${interval})` : ""}`];
  if (meta.hosts.length > 0) {out.push(`${vscode.l10n.t("Hosts")}: ${meta.hosts.map(safeText).join(", ")}`);}
  if (!meta.web_published) {out.push("", vscode.l10n.t("This application has no site published: there is no traffic data."));}
  if (meta.sampled) {out.push(vscode.l10n.t("High traffic: the numbers are estimated from a sample."));}
  if (meta.stale) {out.push(vscode.l10n.t("The numbers may be out of date (last updated {0}).", when(meta.generated_at)));}
  return out;
}

function dimensionTitle(dimension: ApplicationAnalyticsDimension): string {
  switch (dimension) {
    case "path": return vscode.l10n.t("Paths");
    case "country": return vscode.l10n.t("Countries");
    case "referer": return vscode.l10n.t("Referers");
    case "status": return vscode.l10n.t("Status codes");
    case "method": return vscode.l10n.t("Methods");
    case "device": return vscode.l10n.t("Devices");
    case "os": return vscode.l10n.t("Systems");
    case "browser": return vscode.l10n.t("Browsers");
    case "host": return vscode.l10n.t("Hosts");
    case "edge_location": return vscode.l10n.t("Edge locations");
    case "protocol": return vscode.l10n.t("Protocols");
    case "asn": return vscode.l10n.t("Networks (ASN)");
    case "ip": return vscode.l10n.t("IPs");
    case "content_type": return vscode.l10n.t("Content types");
    case "cache_status": return vscode.l10n.t("Cache");
    case "bot": return vscode.l10n.t("Bots");
  }
}

const DIMENSION_ORDER: ApplicationAnalyticsDimension[] = [
  "path", "country", "referer", "status", "method", "device", "os", "browser", "host",
  "edge_location", "protocol", "asn", "ip", "content_type", "cache_status", "bot",
];

function kv(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(22)} ${value}`;
}

export function formatTraffic(data: APIApplicationAnalyticsTraffic, appName: string): string {
  const out = header(vscode.l10n.t("Analytics"), appName, data, data.interval);
  if (!data.web_published) {return out.join("\n");}
  if (!data.summary) {return [...out, "", vscode.l10n.t("No requests in the window.")].join("\n");}
  const s = data.summary;
  const p = data.previous;
  const vs = (cur: number, prev: number | undefined): string =>
    p ? `  (${vscode.l10n.t("vs. previous period")}: ${prev === undefined ? vscode.l10n.t("new") : change(cur, prev)})` : "";
  const ps = p?.summary ?? undefined;
  out.push("");
  out.push(kv(vscode.l10n.t("Requests"), int(s.requests) + vs(s.requests, ps?.requests)));
  out.push(kv(vscode.l10n.t("Visits"), int(s.visits) + vs(s.visits, ps?.visits)));
  out.push(kv(vscode.l10n.t("Data sent"), bytes(s.bytes) + vs(s.bytes, ps?.bytes)));
  out.push(kv(vscode.l10n.t("4xx rate"), `${pct(s.error_rate_4xx)} (${int(s.errors_4xx)})` + vs(s.error_rate_4xx, ps?.error_rate_4xx)));
  out.push(kv(vscode.l10n.t("5xx rate"), `${pct(s.error_rate_5xx)} (${int(s.errors_5xx)})` + vs(s.error_rate_5xx, ps?.error_rate_5xx)));
  out.push(kv(vscode.l10n.t("Edge p95"), ms(s.edge_time_p95_ms) + vs(s.edge_time_p95_ms, ps?.edge_time_p95_ms)));
  if (data.series.length > 1) {out.push(kv(vscode.l10n.t("Requests"), sparkline(data.series.map((pt) => pt.requests))));}
  for (const dimension of DIMENSION_ORDER) {
    const entries = data.breakdowns[dimension];
    if (!entries || entries.length === 0) {continue;}
    out.push("", dimensionTitle(dimension));
    out.push(
      ...table(
        [vscode.l10n.t("Value"), vscode.l10n.t("Requests"), vscode.l10n.t("Visits"), vscode.l10n.t("Data")],
        entries.slice(0, TOP).map((e) => [
          clip(safeText(e.label ? `${e.value} (${e.label})` : e.value), 60),
          int(e.requests),
          int(e.visits),
          bytes(e.bytes),
        ]),
        [1, 2, 3],
      ),
    );
  }
  return out.join("\n");
}

export function formatErrors(data: APIApplicationAnalyticsErrors, appName: string): string {
  const out = header(vscode.l10n.t("Errors"), appName, data, data.interval);
  if (!data.web_published) {return out.join("\n");}
  out.push(data.include_4xx ? vscode.l10n.t("Counting 4xx as errors.") : vscode.l10n.t("Counting 5xx only."));
  if (!data.summary) {return [...out, "", vscode.l10n.t("No requests in the window.")].join("\n");}
  const s = data.summary;
  const ps = data.previous?.summary ?? undefined;
  const vs = (cur: number, prev: number | undefined): string =>
    data.previous ? `  (${vscode.l10n.t("vs. previous period")}: ${prev === undefined ? vscode.l10n.t("new") : change(cur, prev)})` : "";
  out.push("");
  out.push(kv(vscode.l10n.t("Requests"), int(s.requests) + vs(s.requests, ps?.requests)));
  out.push(kv(vscode.l10n.t("Errors"), int(s.errors) + vs(s.errors, ps?.errors)));
  out.push(kv(vscode.l10n.t("Error rate"), pct(s.error_rate) + vs(s.error_rate, ps?.error_rate)));
  out.push(kv("4xx / 5xx", `${int(s.errors_4xx)} / ${int(s.errors_5xx)}`));
  if (data.statuses.length > 0) {
    out.push("", vscode.l10n.t("Errors by status"));
    out.push(...table([vscode.l10n.t("Status"), vscode.l10n.t("Requests")], data.statuses.map((e) => [safeText(e.value), int(e.requests)]), [1]));
  }
  if (data.paths.length > 0) {
    out.push("", vscode.l10n.t("Paths with the most errors"));
    out.push(
      ...table(
        [vscode.l10n.t("Path"), vscode.l10n.t("Errors"), vscode.l10n.t("Requests"), vscode.l10n.t("Rate")],
        data.paths.slice(0, TOP).map((e) => [clip(safeText(e.value), 60), int(e.errors), int(e.requests), pct(e.error_rate)]),
        [1, 2, 3],
      ),
    );
  }
  return out.join("\n");
}

export function formatPerformance(data: APIApplicationAnalyticsPerformance, appName: string): string {
  const out = header(vscode.l10n.t("Performance"), appName, data, data.interval);
  if (!data.web_published) {return out.join("\n");}
  if (!data.summary) {return [...out, "", vscode.l10n.t("No requests in the window.")].join("\n");}
  const { edge, container } = data.summary;
  const prev = data.previous?.summary?.edge;
  const picks: Array<[string, (l: typeof edge) => number]> = [
    [vscode.l10n.t("average"), (l) => l.avg_ms],
    ["p50", (l) => l.p50_ms],
    ["p75", (l) => l.p75_ms],
    ["p90", (l) => l.p90_ms],
    ["p95", (l) => l.p95_ms],
    ["p99", (l) => l.p99_ms],
    ["p99.9", (l) => l.p999_ms],
  ];
  out.push("", `${vscode.l10n.t("Requests")}: ${int(data.summary.requests)}`);
  if (!container) {out.push(vscode.l10n.t("No request reached the container."));}
  out.push("");
  const head = [vscode.l10n.t("Metric"), vscode.l10n.t("Edge"), vscode.l10n.t("Container")];
  if (prev) {head.push(vscode.l10n.t("vs. previous period"));}
  out.push(
    ...table(
      head,
      picks.map(([name, get]) => {
        const row = [name, ms(get(edge)), container ? ms(get(container)) : "-"];
        if (prev) {row.push(change(get(edge), get(prev)));}
        return row;
      }),
      [1, 2, 3],
    ),
  );
  const latHead = [vscode.l10n.t("Value"), vscode.l10n.t("Requests"), "p50", "p95", "p99", vscode.l10n.t("Container p95")];
  const section = (title: string, entries: APIApplicationAnalyticsPerformance["slow_paths"]): void => {
    if (entries.length === 0) {return;}
    out.push("", title);
    out.push(
      ...table(
        latHead,
        entries.slice(0, TOP).map((e) => [
          clip(safeText(e.label ? `${e.value} (${e.label})` : e.value), 60),
          int(e.requests),
          ms(e.edge.p50_ms),
          ms(e.edge.p95_ms),
          ms(e.edge.p99_ms),
          ms(e.container?.p95_ms),
        ]),
        [1, 2, 3, 4, 5],
      ),
    );
  };
  section(vscode.l10n.t("Slowest paths (edge)"), data.slow_paths);
  section(vscode.l10n.t("By country (edge)"), data.countries);
  section(vscode.l10n.t("By edge location (edge)"), data.edge_locations);
  if (data.path_issues.length > 0) {
    out.push("", vscode.l10n.t("Problems by path"));
    out.push(
      ...table(
        [vscode.l10n.t("Path"), vscode.l10n.t("Requests"), vscode.l10n.t("Error rate"), vscode.l10n.t("Average"), "p99"],
        data.path_issues.slice(0, TOP).map((e) => [clip(safeText(e.path), 60), int(e.requests), pct(e.error_rate), ms(e.avg_ms), ms(e.p99_ms)]),
        [1, 2, 3, 4],
      ),
    );
  }
  return out.join("\n");
}

export function formatRequests(data: APIApplicationAnalyticsRequestList, appName: string): string {
  const out = header(vscode.l10n.t("Requests"), appName, data);
  if (!data.web_published) {return out.join("\n");}
  if (data.requests.length === 0) {return [...out, "", vscode.l10n.t("No requests found.")].join("\n");}
  out.push("");
  out.push(
    ...table(
      [vscode.l10n.t("When"), vscode.l10n.t("Method"), vscode.l10n.t("Status"), vscode.l10n.t("Path"), vscode.l10n.t("Edge"), vscode.l10n.t("Container"), vscode.l10n.t("Country"), vscode.l10n.t("Cache"), "request_id"],
      data.requests.map((r) => {
        const status = r.container_status !== null && r.container_status !== r.status ? `${r.status}/${r.container_status}` : String(r.status);
        return [
          new Intl.DateTimeFormat(vscode.env.language, { dateStyle: "short", timeStyle: "medium" }).format(new Date(r.time)),
          safeText(r.method),
          status,
          clip(safeText(r.query ? `${r.path}?${r.query}` : r.path), 60),
          ms(r.edge_time_ms),
          ms(r.container_time_ms),
          safeText(r.country),
          safeText(r.cache_status),
          safeText(r.request_id),
        ];
      }),
      [4, 5],
    ),
  );
  out.push("", vscode.l10n.t("Path, referer and network fields come from visitors: shown as plain text."));
  return out.join("\n");
}

interface WindowChoice extends vscode.QuickPickItem {
  hours: number;
}

/** Janela máxima aceita: 30 dias menos 1 minuto. */
function windowOf(hours: number): Required<AnalyticsWindow> {
  const end = new Date();
  const span = hours * HOUR - (hours >= 720 ? 60_000 : 0);
  return { start: new Date(end.getTime() - span).toISOString(), end: end.toISOString() };
}

async function pickWindow(): Promise<Required<AnalyticsWindow> | undefined> {
  const choices: WindowChoice[] = [
    { label: vscode.l10n.t("Last 24 hours"), hours: 24 },
    { label: vscode.l10n.t("Last 7 days"), hours: 24 * 7 },
    { label: vscode.l10n.t("Last 30 days"), hours: 24 * 30 },
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    title: vscode.l10n.t("Analytics window"),
    placeHolder: vscode.l10n.t("How far back to look"),
  });
  return picked ? windowOf(picked.hours) : undefined;
}

async function show(text: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function showRequests(deps: CommandDeps, app: App, window: Required<AnalyticsWindow>, cursor?: string): Promise<void> {
  const data = await listAnalyticsRequests(deps.client, app.id, window, cursor);
  await show(formatRequests(data, app.name));
  if (data.cursor) {
    const next = vscode.l10n.t("Next page");
    const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Showing {0} requests, newest first.", data.requests.length), next);
    if (choice === next) {await showRequests(deps, app, window, data.cursor);}
  }
}

async function open(deps: CommandDeps, arg: unknown, view: View | undefined): Promise<void> {
  const app = (await deps.resolveApp(arg))?.app;
  if (!app) {return;}
  let chosen = view;
  if (!chosen) {
    const options: Array<vscode.QuickPickItem & { view: View }> = [
      { label: vscode.l10n.t("Summary"), description: vscode.l10n.t("Traffic, visits, errors and top values"), view: "summary" },
      { label: vscode.l10n.t("Performance"), description: vscode.l10n.t("Edge and container latency"), view: "performance" },
      { label: vscode.l10n.t("Errors"), description: vscode.l10n.t("5xx by status and path"), view: "errors" },
      { label: vscode.l10n.t("Requests"), description: vscode.l10n.t("Request log"), view: "requests" },
    ];
    const picked = await vscode.window.showQuickPick(options, { title: vscode.l10n.t("Analytics — {0}", app.name) });
    if (!picked) {return;}
    chosen = picked.view;
  }
  const window = await pickWindow();
  if (!window) {return;}
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Loading analytics of {0}...", app.name) },
      async () => {
        switch (chosen) {
          case "summary": return show(formatTraffic(await getAnalytics(deps.client, app.id, window), app.name));
          case "performance": return show(formatPerformance(await getAnalyticsPerformance(deps.client, app.id, window), app.name));
          case "errors": return show(formatErrors(await getAnalyticsErrors(deps.client, app.id, window), app.name));
          default: return showRequests(deps, app, window);
        }
      },
    );
  } catch (err) {
    deps.showError(err);
  }
}

export function registerAnalyticsCommands(deps: CommandDeps): void {
  const reg = (id: string, view?: View): void => {
    deps.context.subscriptions.push(vscode.commands.registerCommand(id, (arg: unknown) => open(deps, arg, view)));
  };
  reg("vertraCloud.app.analytics");
  reg("vertraCloud.app.analytics.summary", "summary");
  reg("vertraCloud.app.analytics.performance", "performance");
  reg("vertraCloud.app.analytics.errors", "errors");
  reg("vertraCloud.app.analytics.requests", "requests");
}
