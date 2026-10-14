import * as vscode from "vscode";
import { describeError, type ApiErrorLike } from "../l10n";

/** Blob codes that need their own sentence; everything else falls through to the shared catalog. */
const BLOB_CODES = new Set([
  "BLOB_OBJECT_NOT_FOUND",
  "BLOB_OBJECT_ALREADY_EXISTS",
  "BLOB_FILE_TOO_LARGE",
  "STORAGE_QUOTA_EXCEEDED",
  "BLOCKED_FILE_TYPE",
  "BLOB_NAMESPACE_SUSPENDED",
  "BLOB_UPLOAD_LIMIT",
  "BLOB_UPLOAD_EXPIRED",
  "BLOB_UPLOAD_INCOMPLETE",
  "BLOB_CHECKSUM_MISMATCH",
  "UPLOAD_FAILED",
  "WORKSPACE_PERMISSION_DENIED",
  "VALIDATION_ERROR",
  "BLOB_BASE_URL_UNTRUSTED",
]);

export function errorCodeOf(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
}

export function isBlobSpecific(code: string): boolean {
  return BLOB_CODES.has(code);
}

/** Never echoes the raw API message for a known code. */
export function describeBlobError(err: ApiErrorLike): string {
  switch (err.code) {
    case "BLOB_OBJECT_NOT_FOUND":
      return vscode.l10n.t("The file no longer exists. Refresh the Blob view.");
    case "BLOB_OBJECT_ALREADY_EXISTS":
      return vscode.l10n.t("A file already exists at this path.");
    case "BLOB_FILE_TOO_LARGE":
      return vscode.l10n.t("The file is larger than your plan allows.");
    case "STORAGE_QUOTA_EXCEEDED":
      return vscode.l10n.t("Your Blob storage is full. Delete files or upgrade your plan.");
    case "BLOCKED_FILE_TYPE":
      return vscode.l10n.t("This file type isn't allowed.");
    case "BLOB_NAMESPACE_SUSPENDED":
      return vscode.l10n.t("Blob Storage is suspended for this account.");
    case "BLOB_UPLOAD_LIMIT":
      return vscode.l10n.t("Too many uploads are in progress. Try again shortly.");
    case "BLOB_UPLOAD_EXPIRED":
      return vscode.l10n.t("The upload expired. Send the file again.");
    case "BLOB_UPLOAD_INCOMPLETE":
    case "BLOB_CHECKSUM_MISMATCH":
    case "UPLOAD_FAILED":
      return vscode.l10n.t("The upload failed. Send the file again.");
    case "WORKSPACE_PERMISSION_DENIED":
      return vscode.l10n.t("You don't have permission to use Blob Storage here.");
    case "VALIDATION_ERROR":
      return vscode.l10n.t("The path or value isn't valid.");
    case "BLOB_BASE_URL_UNTRUSTED":
      return vscode.l10n.t("The Blob base URL must be an https address on vertracloud.app. Your token was not sent.");
    default:
      return describeError(err);
  }
}
