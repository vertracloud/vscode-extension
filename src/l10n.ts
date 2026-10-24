import * as vscode from "vscode";
import { formatIssues, issuesFromDetails } from "./images/issues";

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
    case "PLAN_REQUIRED":
      return vscode.l10n.t("A plan is required for this action. Choose a plan to continue.");
    case "INVALID_DATABASE_VERSION":
      return vscode.l10n.t("Invalid database version for this engine. Pick one of the available versions.");
    case "SNAPSHOT_VERSION_NEWER":
      return vscode.l10n.t("The chosen version is older than the snapshot's. Use the same version or a newer one.");
    case "DOMAIN_NOT_FOUND":
      return vscode.l10n.t("Domain not found.");
    case "DOMAIN_LIMIT_REACHED":
      return vscode.l10n.t("Your plan's custom domain limit was reached.");
    case "DOMAIN_PORT_LIMIT_REACHED":
      return vscode.l10n.t("This application already uses the maximum number of distinct ports.");
    case "INVALID_DOMAIN_PORT":
      return vscode.l10n.t("Invalid port. Use a port between 1 and 65535.");
    case "INVALID_PATH_PREFIX":
      return vscode.l10n.t("Invalid path prefix.");
    case "INVALID_REDIRECT_TARGET":
      return vscode.l10n.t("Invalid redirect target.");
    case "INVALID_CUSTOM_DOMAIN_FORMAT":
      return vscode.l10n.t("The domain format is invalid.");
    case "DOMAIN_ALREADY_IN_USE":
      return vscode.l10n.t("This domain is already in use.");
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
    case "APP_BUILDING":
      return vscode.l10n.t("The application is still building. Try again when it finishes.");
    case "APP_SHIELD_COOLDOWN":
      return vscode.l10n.t("This application is in cooldown after a network incident.");
    case "PLAN_DOES_NOT_SUPPORT_CUSTOM_IMAGES":
      return vscode.l10n.t("Custom Docker images are available on Enterprise 28, 30 and 32.");
    case "MAX_IMAGES_REACHED":
      return vscode.l10n.t("You reached your plan's limit of Docker images. Delete one to create another.");
    case "DOCKERFILE_NOT_FOUND":
      return vscode.l10n.t("There is no file named exactly Dockerfile at the root of the project.");
    case "DOCKERFILE_REFUSED": {
      const found = formatIssues(issuesFromDetails(err.details));
      const base = vscode.l10n.t("The Dockerfile has instructions the platform refuses.");
      return found.length > 0 ? `${base} ${found.join("; ")}` : base;
    }
    case "IMAGE_CONTEXT_TOO_LARGE":
      // Recusa local, antes do envio: a mensagem já vem traduzida e diz qual limite estourou.
      if (err.message && err.details && typeof err.details === "object" && (err.details as { local?: unknown }).local === true) {return err.message;}
      return vscode.l10n.t("The build context is too large (limits: 100 MB sent, 512 MB uncompressed, 50,000 files and a 1 MB Dockerfile). Use a .dockerignore.");
    case "IMAGE_BUILD_IN_PROGRESS":
      return vscode.l10n.t("A build of this image is already running. Wait for it to finish and try again.");
    case "IMAGE_NOT_READY":
      return vscode.l10n.t("The image has no ready version yet. Wait for the build to finish.");
    case "IMAGE_TOO_LARGE":
      return vscode.l10n.t("The built image is larger than 10 GB uncompressed.");
    case "IMAGE_LABEL_REFUSED":
      return vscode.l10n.t("The image sets a label that the platform reserves. Remove it and build again.");
    case "IMAGE_VOLUME_REFUSED":
      return vscode.l10n.t("The image declares a VOLUME at /app or below (or with a relative path), which the platform does not accept.");
    case "IMAGE_BUILDER_UNAVAILABLE":
      return vscode.l10n.t("Images can't be built right now. Try again shortly.");
    case "IMAGE_NAME_MISMATCH":
      return vscode.l10n.t("The name typed is not the image name.");
    case "IMAGE_NOT_FOUND":
      return vscode.l10n.t("Image not found.");
    case "IMAGE_VERSION_NOT_FOUND":
      return vscode.l10n.t("Image version not found, or its log was not stored.");
    case "IMAGE_APP_PORT_REQUIRED":
      return vscode.l10n.t("Give the port the image listens on, because the application has no port yet.");
    case "IMAGE_APP_FIELD_NOT_APPLICABLE":
      return vscode.l10n.t("Language, version, main file, start and build commands come from the image and can't be changed here.");
    case "IMAGE_APP_CODE_NOT_APPLICABLE":
      return vscode.l10n.t("This application runs from an image, so its code can't be edited in place. Update the image instead.");
    default:
      return err.message ?? err.code;
  }
}

export function statusLabel(status: "up" | "down" | "installing" | "building"): string {
  switch (status) {
    case "up":
      return vscode.l10n.t("Online");
    case "installing":
      return vscode.l10n.t("Installing");
    case "building":
      return vscode.l10n.t("Building");
    default:
      return vscode.l10n.t("Offline");
  }
}

/** Orientação curta para o código `last_build_error` de um app; `undefined` para código desconhecido. */
export function buildErrorHint(code: string | null | undefined): string | undefined {
  switch (code) {
    case "INSTALL_OUT_OF_MEMORY":
      return vscode.l10n.t("Not enough memory to install dependencies: raise the app memory.");
    case "BUILD_FAILED":
      return vscode.l10n.t("The build failed: read the logs and fix the project.");
    case "INSTALL_FAILED":
      return vscode.l10n.t("Installing dependencies failed: read the logs and fix the project.");
    case "BUILD_TIMEOUT":
      return vscode.l10n.t("The build took too long: make it shorter.");
    case "INSTALL_TIMEOUT":
      return vscode.l10n.t("The install took too long: make it shorter.");
    case "BUILD_INTERRUPTED":
      return vscode.l10n.t("The build was interrupted: try again.");
    case "INSTALL_SHIELD_BLOCKED":
      return vscode.l10n.t("Network protection blocked traffic during the build.");
    default:
      return undefined;
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
