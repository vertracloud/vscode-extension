import * as vscode from "vscode";
import type { APIApplicationMetric, RESTPostAPIApplicationRestartBody } from "@vertracloud/api-types/v1";
import { deleteApp, getAppMetrics, restartApp, startApp, stopApp, type MetricsRange } from "../api/endpoints";
import { formatBytes } from "../l10n";
import type { CommandDeps } from "./deps";
import { appIdOf, openUrl, register, workspaceIdOf } from "./index";

const RANGES: MetricsRange[] = ["10m", "30m", "24h"];

function summarize(metrics: APIApplicationMetric[]): string[] {
  const last = metrics[metrics.length - 1];
  const cpus = metrics.map((m) => m.cpu);
  const rams = metrics.map((m) => m.ram);
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const [inBytes = 0, outBytes = 0] = last.network;

  return [
    vscode.l10n.t("CPU now: {0}%", last.cpu.toFixed(2)),
    vscode.l10n.t("RAM now: {0}", formatBytes(last.ram)),
    vscode.l10n.t("Network: {0} in · {1} out", formatBytes(inBytes), formatBytes(outBytes)),
    vscode.l10n.t("Storage: {0}", formatBytes(last.storage)),
    vscode.l10n.t("CPU average: {0}% · peak {1}%", avg(cpus).toFixed(2), Math.max(...cpus).toFixed(2)),
    vscode.l10n.t("RAM average: {0} · peak {1}", formatBytes(avg(rams)), formatBytes(Math.max(...rams))),
  ];
}

export function registerAppsCommands(deps: CommandDeps): void {
  const { context } = deps;

  const operate = async (
    arg: unknown,
    run: (id: string) => Promise<unknown>,
    expect: "up" | "down",
  ): Promise<void> => {
    const entry = await deps.resolveApp(arg);
    if (!entry) {return;}
    try {
      await run(entry.app.id);
    } catch (err) {
      deps.showError(err);
      return;
    }
    await deps.store.pollAfterMutation(entry.app.id, expect);
  };

  const confirmRestart = async (title: string): Promise<boolean> => {
    const confirm = vscode.l10n.t("Restart");
    const choice = await vscode.window.showWarningMessage(
      `${title} ${vscode.l10n.t("This counts toward your hourly deploy limit.")}`,
      { modal: true },
      confirm,
    );
    return choice === confirm;
  };

  const restart = (body?: RESTPostAPIApplicationRestartBody) => async (arg: unknown) => {
    const title = body?.reinstall_dependencies
      ? vscode.l10n.t("Restart and reinstall dependencies?")
      : body?.force_build
        ? vscode.l10n.t("Restart and run the build again?")
        : vscode.l10n.t("Restart this application?");
    if (!(await confirmRestart(title))) {return;}
    await operate(arg, (id) => restartApp(deps.client, id, body), "up");
  };

  register(context, "vertraCloud.app.start", (arg: unknown) =>
    operate(arg, (id) => startApp(deps.client, id), "up"),
  );
  register(context, "vertraCloud.app.stop", (arg: unknown) =>
    operate(arg, (id) => stopApp(deps.client, id), "down"),
  );
  register(context, "vertraCloud.app.restart", restart());
  register(context, "vertraCloud.app.restartReinstall", restart({ reinstall_dependencies: true }));
  register(context, "vertraCloud.app.restartForceBuild", restart({ force_build: true }));

  register(context, "vertraCloud.app.open", async (arg: unknown) => {
    const entry = await deps.resolveApp(arg);
    if (!entry) {return;}
    if (!entry.app.public_url) {
      void vscode.window.showInformationMessage(vscode.l10n.t("This application isn't published to the web."));
      return;
    }
    openUrl(entry.app.public_url);
  });

  register(context, "vertraCloud.app.favorite", async (arg: unknown) => {
    const workspaceId = workspaceIdOf(arg);
    if (workspaceId) {
      const id = appIdOf(arg);
      if (id && !deps.store.isFavorite("application", id, workspaceId)) {await deps.store.toggleFavorite("application", id, workspaceId);}
      return;
    }
    const entry = await deps.resolveApp(arg);
    if (entry && !entry.favorite) {await deps.store.toggleFavorite("application", entry.app.id);}
  });

  register(context, "vertraCloud.app.unfavorite", async (arg: unknown) => {
    const workspaceId = workspaceIdOf(arg);
    if (workspaceId) {
      const id = appIdOf(arg);
      if (id && deps.store.isFavorite("application", id, workspaceId)) {await deps.store.toggleFavorite("application", id, workspaceId);}
      return;
    }
    const entry = await deps.resolveApp(arg);
    if (entry?.favorite) {await deps.store.toggleFavorite("application", entry.app.id);}
  });

  register(context, "vertraCloud.app.showMetrics", async (arg: unknown) => {
    const entry = await deps.resolveApp(arg);
    if (!entry) {return;}
    const range = (await vscode.window.showQuickPick(RANGES, {
      placeHolder: vscode.l10n.t("Select a time range"),
    })) as MetricsRange | undefined;
    if (!range) {return;}

    let metrics: APIApplicationMetric[];
    try {
      metrics = await getAppMetrics(deps.client, entry.app.id, range);
    } catch (err) {
      deps.showError(err);
      return;
    }
    if (metrics.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No metrics for this period."));
      return;
    }
    await vscode.window.showQuickPick(
      summarize(metrics).map((label) => ({ label })),
      { placeHolder: `${entry.app.name} · ${range}` },
    );
  });

  register(context, "vertraCloud.app.delete", async (arg: unknown) => {
    const entry = await deps.resolveApp(arg);
    if (!entry) {return;}
    if (!(await deps.confirmDanger(entry.app.name, vscode.l10n.t("Delete application")))) {return;}
    try {
      await deleteApp(deps.client, entry.app.id);
    } catch (err) {
      deps.showError(err);
      return;
    }
    await deps.refresh();
  });
}

export { summarize };
