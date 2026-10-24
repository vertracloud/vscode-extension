import * as vscode from "vscode";
import type { DockerfileIssue, DockerfileIssueCode } from "@vertracloud/api-types/v1";

/** Frase de cada achado da checagem do Dockerfile. Código desconhecido volta como está: nunca texto do servidor. */
export function issueLabel(code: DockerfileIssueCode): string {
  switch (code) {
    case "missing_dockerfile":
      return vscode.l10n.t("There is no Dockerfile at the root of the project");
    case "syntax_frontend":
      return vscode.l10n.t("# syntax= points to an unofficial frontend");
    case "run_security_insecure":
      return vscode.l10n.t("RUN --security=insecure is not allowed");
    case "run_network_host":
      return vscode.l10n.t("RUN --network=host is not allowed");
    case "mount_ssh":
      return vscode.l10n.t("--mount=type=ssh is not allowed");
    case "mount_secret":
      return vscode.l10n.t("--mount=type=secret is not allowed");
    case "workdir_app":
      return vscode.l10n.t("WORKDIR at /app or below: /app is the persistent disk and hides what the image puts there");
    case "env_file_in_context":
      return vscode.l10n.t(".env files do not go into the image; their keys become app variables");
    case "copy_env_file":
      return vscode.l10n.t("COPY or ADD of a .env file: the file is not in the build context, so the build fails on this line");
    case "volume_outside_app":
      return vscode.l10n.t("VOLUME outside /app becomes a temporary 64 MB folder, erased on every restart");
    case "volume_refused":
      return vscode.l10n.t("VOLUME at /app or below, or with a relative path, is not allowed");
    default:
      return String(code);
  }
}

export function formatIssue(issue: DockerfileIssue): string {
  const label = issueLabel(issue.code);
  return typeof issue.line === "number" ? vscode.l10n.t("Line {0}: {1}", issue.line, label) : label;
}

export function formatIssues(issues: readonly DockerfileIssue[]): string[] {
  return issues.map(formatIssue);
}

/** Lê `details.issues` do erro `DOCKERFILE_REFUSED` sem confiar no formato. */
export function issuesFromDetails(details: unknown): DockerfileIssue[] {
  const issues = details && typeof details === "object" ? (details as { issues?: unknown }).issues : undefined;
  if (!Array.isArray(issues)) {return [];}
  const out: DockerfileIssue[] = [];
  for (const item of issues) {
    if (!item || typeof item !== "object") {continue;}
    const { code, line } = item as { code?: unknown; line?: unknown };
    if (typeof code !== "string") {continue;}
    out.push({ code: code as DockerfileIssueCode, line: typeof line === "number" ? line : null });
  }
  return out;
}
