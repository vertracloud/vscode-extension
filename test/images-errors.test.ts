import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { describeError } from "../src/l10n";
import { formatIssue, formatIssues, issueLabel } from "../src/images/issues";

const REFUSAL_CODES = ["missing_dockerfile", "syntax_frontend", "run_security_insecure", "run_network_host", "mount_ssh", "mount_secret", "volume_refused"] as const;
const WARNING_CODES = ["workdir_app", "env_file_in_context", "copy_env_file", "volume_outside_app"] as const;

describe("issueLabel / formatIssue", () => {
  it("has a sentence for every code of the Dockerfile check", () => {
    for (const code of [...REFUSAL_CODES, ...WARNING_CODES]) {
      const label = issueLabel(code);
      assert.notEqual(label, code, code);
      assert.ok(label.length > 10, code);
    }
  });

  it("never echoes an unknown code as if it were a sentence from the server", () => {
    assert.equal(issueLabel("something_new" as never), "something_new");
  });

  it("prefixes the line when there is one", () => {
    assert.equal(formatIssue({ code: "mount_ssh", line: 7 }), `Line 7: ${issueLabel("mount_ssh")}`);
    assert.equal(formatIssue({ code: "missing_dockerfile", line: null }), issueLabel("missing_dockerfile"));
  });

  it("formats a list in order", () => {
    assert.deepEqual(
      formatIssues([{ code: "mount_ssh", line: 2 }, { code: "workdir_app", line: null }]),
      [formatIssue({ code: "mount_ssh", line: 2 }), formatIssue({ code: "workdir_app", line: null })],
    );
  });
});

describe("describeError for the image codes", () => {
  const codes = [
    "PLAN_DOES_NOT_SUPPORT_CUSTOM_IMAGES",
    "MAX_IMAGES_REACHED",
    "DOCKERFILE_NOT_FOUND",
    "DOCKERFILE_REFUSED",
    "IMAGE_CONTEXT_TOO_LARGE",
    "IMAGE_BUILD_IN_PROGRESS",
    "IMAGE_NOT_READY",
    "IMAGE_TOO_LARGE",
    "IMAGE_LABEL_REFUSED",
    "IMAGE_VOLUME_REFUSED",
    "IMAGE_BUILDER_UNAVAILABLE",
    "IMAGE_NAME_MISMATCH",
    "IMAGE_NOT_FOUND",
    "IMAGE_VERSION_NOT_FOUND",
    "IMAGE_APP_PORT_REQUIRED",
    "IMAGE_APP_FIELD_NOT_APPLICABLE",
    "IMAGE_APP_CODE_NOT_APPLICABLE",
  ];

  it("translates every code and never echoes the raw API message", () => {
    for (const code of codes) {
      const text = describeError({ code, message: "RAW-SERVER-TEXT" });
      assert.ok(!text.includes("RAW-SERVER-TEXT"), code);
      assert.notEqual(text, code);
    }
  });

  it("lists the refused findings with their lines on DOCKERFILE_REFUSED", () => {
    const text = describeError({
      code: "DOCKERFILE_REFUSED",
      details: { issues: [{ code: "run_network_host", line: 4 }, { code: "mount_secret", line: null }] },
    });
    assert.ok(text.includes(formatIssue({ code: "run_network_host", line: 4 })));
    assert.ok(text.includes(formatIssue({ code: "mount_secret", line: null })));
  });

  it("tolerates DOCKERFILE_REFUSED details that are missing or malformed", () => {
    assert.ok(describeError({ code: "DOCKERFILE_REFUSED" }).length > 0);
    assert.ok(describeError({ code: "DOCKERFILE_REFUSED", details: { issues: "nope" } }).length > 0);
    assert.ok(describeError({ code: "DOCKERFILE_REFUSED", details: { issues: [null, { code: 3 }] } }).length > 0);
  });
});

describe("local context refusals", () => {
  it("shows the specific local message (already translated) instead of the generic one", () => {
    const text = describeError({ code: "IMAGE_CONTEXT_TOO_LARGE", message: "Local: 600 MB", details: { local: true } });
    assert.equal(text, "Local: 600 MB");
  });

  it("does not trust a message that is not marked as local", () => {
    const text = describeError({ code: "IMAGE_CONTEXT_TOO_LARGE", message: "from the server", details: {} });
    assert.ok(!text.includes("from the server"));
  });
});
