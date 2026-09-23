import * as vscode from "vscode";

/** Estrutura mínima que qualquer erro de API (ApiError real ou fake de teste) precisa ter. */
export interface ApiErrorLike {
  code: string;
  message?: string;
  retryAfter?: number;
  details?: unknown;
}

function formatRetryAfter(seconds: number): string {
  if (seconds < 60) {return vscode.l10n.t("in {0}s", seconds);}
  return vscode.l10n.t("in {0} min", Math.ceil(seconds / 60));
}

/** Traduz um código de erro estável da API para uma frase acionável. Nunca ecoa a mensagem crua da API. */
export function describeError(err: ApiErrorLike): string {
  const retry = err.retryAfter !== undefined ? ` ${formatRetryAfter(err.retryAfter)}.` : "";
  switch (err.code) {
    case "API_KEY_INVALID":
      return vscode.l10n.t("Your API key is invalid. Reconnect your account.");
    case "API_KEY_SCOPE_DENIED": {
      const required =
        err.details && typeof err.details === "object" && "required" in err.details
          ? String((err.details as { required?: unknown }).required)
          : undefined;
      return required
        ? vscode.l10n.t("Your API key doesn't have the \"{0}\" permission.", required)
        : vscode.l10n.t("Your API key doesn't have permission for this action.");
    }
    case "RATE_LIMIT_EXCEEDED":
      return vscode.l10n.t("Too many requests.") + retry;
    case "DAILY_QUOTA_EXCEEDED":
      return vscode.l10n.t("Daily quota reached.") + retry;
    case "DEPLOY_RATE_LIMITED":
      return vscode.l10n.t("Too many deploys.") + retry;
    case "SNAPSHOT_RATE_LIMITED":
      return vscode.l10n.t("Too many snapshots.") + retry;
    case "PLAN_RESTRICTED_FEATURE":
      return vscode.l10n.t("Your plan doesn't include this feature.");
    case "PLAN_DOES_NOT_SUPPORT_WEB_PUBLISH":
      return vscode.l10n.t("Your plan doesn't support publishing to the web.");
    case "PLAN_DOES_NOT_SUPPORT_CUSTOM_SUBDOMAIN":
      return vscode.l10n.t("Your plan doesn't support a custom subdomain.");
    case "PLAN_NOT_ALLOWED":
      return vscode.l10n.t("Your plan doesn't allow this action.");
    case "OPERATION_IN_PROGRESS":
      return vscode.l10n.t("Another operation is already in progress for this resource.");
    case "CONTAINER_ALREADY_RUNNING":
      return vscode.l10n.t("The container is already running.");
    case "APP_NOT_FOUND":
      return vscode.l10n.t("Application not found.");
    case "DATABASE_NOT_FOUND":
      return vscode.l10n.t("Database not found.");
    case "ACCESS_DENIED":
      return vscode.l10n.t("You don't have access to this resource.");
    case "WEBSITE_ONLY":
      return vscode.l10n.t("This action is only available on the dashboard.");
    case "FILE_TOO_LARGE":
      return vscode.l10n.t("The file is too large.");
    case "NO_FILE_UPLOADED":
      return vscode.l10n.t("No file was uploaded.");
    case "FILE_MODIFIED":
      return vscode.l10n.t("The file changed since it was last read. Reload it before saving.");
    case "NETWORK_ERROR":
      return vscode.l10n.t("Couldn't reach Vertra Cloud. Check your connection.");
    case "TIMEOUT":
      return vscode.l10n.t("The request timed out.");
    case "CANCELLED":
      return vscode.l10n.t("Cancelled.");
    case "SUBDOMAIN_TAKEN":
      return vscode.l10n.t("This subdomain is already taken.");
    case "SUBDOMAIN_FORBIDDEN":
      return vscode.l10n.t("This subdomain isn't allowed.");
    case "SUBDOMAIN_CHANGE_RATE_LIMITED":
      return vscode.l10n.t("You changed the subdomain too recently.") + retry;
    case "APP_ALREADY_PUBLISHED":
      return vscode.l10n.t("The application is already published.");
    case "APP_NOT_PUBLISHED":
      return vscode.l10n.t("The application isn't published.");
    case "MEMORY_BELOW_MINIMUM":
      return vscode.l10n.t("The RAM amount is below the minimum allowed.");
    case "ENV_LIMIT_EXCEEDED":
      return vscode.l10n.t("You reached the environment variable limit.");
    case "ENV_DUPLICATE_KEY":
      return vscode.l10n.t("This environment variable already exists.");
    case "FORBIDDEN_KEY":
      return vscode.l10n.t("This key name isn't allowed.");
    case "RESTORE_COOLDOWN":
      return vscode.l10n.t("You need to wait before restoring again.") + retry;
    case "ACCOUNT_BANNED":
      return vscode.l10n.t("Your account has been suspended.");
    case "APP_BANNED":
      return vscode.l10n.t("This application has been suspended.");
    case "APP_SHIELD_COOLDOWN":
      return vscode.l10n.t("This application is in cooldown after a network incident.");
    default:
      return err.message ?? err.code;
  }
}

export function statusLabel(status: "up" | "down" | "installing"): string {
  switch (status) {
    case "up":
      return vscode.l10n.t("Online");
    case "installing":
      return vscode.l10n.t("Installing");
    default:
      return vscode.l10n.t("Offline");
  }
}

export function formatMegabytes(megabytes: number): string {
  if (!Number.isFinite(megabytes) || megabytes < 0) {return vscode.l10n.t("Unknown");}
  if (megabytes >= 1024) {
    const gb = megabytes / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${megabytes} MB`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {return vscode.l10n.t("Unknown");}
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {return vscode.l10n.t("Unknown");}
  if (seconds < 60) {return vscode.l10n.t("{0}s", Math.floor(seconds));}
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {return vscode.l10n.t("{0} min", minutes);}
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {return vscode.l10n.t("{0}h {1}min", hours, minutes % 60);}
  const days = Math.floor(hours / 24);
  return vscode.l10n.t("{0}d {1}h", days, hours % 24);
}
